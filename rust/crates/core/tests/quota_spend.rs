use ycoding_core::resources::model::quota::{LocalSpendRow, local_spend_snapshots};
use ycoding_schema::provider;
#[path = "report_support/mod.rs"]
mod report_support;

#[test]
fn local_spend_uses_local_calendar_day_filters_invalid_costs_and_never_invents_totals() {
    let Ok(tz) = std::env::var("YCODING_SPEND_CHILD") else {
        for tz in ["UTC", "America/New_York", "Asia/Bangkok"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap()).args(["--exact","local_spend_uses_local_calendar_day_filters_invalid_costs_and_never_invents_totals","--nocapture"]).env("TZ",tz).env("YCODING_SPEND_CHILD",tz).output().unwrap();
            assert!(
                output.status.success(),
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    let (now, start, end) = match tz.as_str() {
        "UTC" => (1772971200000, 1772928000000, 1773014400000),
        "America/New_York" => (1772971200000, 1772946000000, 1773028800000),
        "Asia/Bangkok" => (1772971200000, 1772902800000, 1772989200000),
        _ => unreachable!(),
    };
    let row = |provider: &str, cost, time_created| LocalSpendRow {
        provider_id: provider::Id(provider.into()),
        cost,
        time_created,
    };
    let snapshots = local_spend_snapshots(
        &[
            row("openai", Some(1.0), start),
            row("openai", Some(2.0), end - 1),
            row("openai", Some(100.0), end),
            row("openai", Some(100.0), start - 1),
            row("anthropic", None, now),
            row("anthropic", Some(-1.0), now),
            row("anthropic", Some(f64::NAN), now),
            row("anthropic", Some(0.0), now),
            row("opencode-go", Some(0.0), now),
            row(
                ycoding_core::resources::model::UPSTREAM_PROVIDER_ID,
                Some(10.0),
                now,
            ),
            row("xai", Some(10.0), now),
            row("meta", Some(2.0), now),
        ],
        now,
    )
    .unwrap();
    assert_eq!(
        snapshots
            .iter()
            .map(|s| (
                s.provider_id.0.to_utf8().unwrap(),
                s.label.to_utf8().unwrap(),
                s.windows[0].used
            ))
            .collect::<Vec<_>>(),
        [
            ("anthropic".into(), "Claude".into(), Some(0.0)),
            ("openai".into(), "Openai".into(), Some(3.0)),
            ("opencode".into(), "OpenCode Zen".into(), Some(10.0)),
            ("opencode-go".into(), "OpenCode Go".into(), Some(0.0)),
            ("xai".into(), "Xai".into(), Some(10.0)),
        ]
        .map(|(id, label, used): (String, String, Option<f64>)| (id, label, used))
    );
    assert!(
        snapshots.iter().all(
            |s| s.source == "local_session".into() && s.profile == Some("YCoding local".into())
        )
    );
    assert!(
        snapshots
            .iter()
            .all(|s| s.windows[0].remaining.is_none() && s.windows[0].limit.is_none())
    );
}

const NOW: i64 = 1790598896000;
const DAY: i64 = 86_400_000;

fn store() -> ycoding_store::Store {
    use ycoding_store::{project, resources, session};
    let tables = Box::leak(
        project::TABLES
            .iter()
            .chain(session::TABLES)
            .chain(resources::TABLES)
            .chain(ycoding_store::usage_cells::TABLES)
            .copied()
            .chain([
                ycoding_store::TableDeclaration::of::<ycoding_store::analytics::DeliveryTable>(),
                ycoding_store::TableDeclaration::of::<ycoding_store::analytics::IntentTable>(),
            ])
            .collect::<Vec<_>>()
            .into_boxed_slice(),
    );
    ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, tables),
        ycoding_store::Metadata::new([12; 16], 1),
    )
    .unwrap()
}

fn analytics_rows() -> Vec<(&'static str, Option<f64>, i64)> {
    vec![
        ("openai", Some(1.0), NOW),
        ("openai", Some(2.0), NOW),
        ("openai", None, NOW),
        ("openai", Some(-1.0), NOW),
        ("openai", Some(500.0), NOW - 2 * DAY),
        ("openai", Some(500.0), NOW + 2 * DAY),
        ("anthropic", Some(0.0), NOW),
        ("opencode-go", Some(10.0), NOW),
        (
            ycoding_core::resources::model::UPSTREAM_PROVIDER_ID,
            Some(10.0),
            NOW,
        ),
        ("xai", Some(10.0), NOW),
        ("meta", Some(7.0), NOW),
    ]
}

fn put_analytics(store: &ycoding_store::Store, rows: Vec<(&'static str, Option<f64>, i64)>) {
    use ycoding_store::{resources, session};
    let rows = rows.into_iter().enumerate().collect::<Vec<_>>();
    for chunk in rows.chunks(128) {
        let rows = chunk.to_vec();
        store.submit(move |tx| {
        for (index, (provider, cost, time_created)) in rows {
            resources::UsageAnalyticsRequestTable::insert(tx, &resources::UsageAnalyticsRequest {
                id: format!("analytics-{index}").into(),
                session_id: "gone".into(),
                project_id: "p".into(),
                directory: "".into(),
                workspace_id: None,
                session_updated: 0,
                agent: "fixture".into(),
                source: "step".into(),
                model: session::Document::from_domain(&ycoding_schema::model::Ref {
                    id: "m".into(),
                    provider_id: provider::Id(provider.into()),
                    variant: None,
                    profile: None,
                })?,
                usage_anchor: None,
                task_path: session::Document::new(ycoding_schema::parse_json("[]").unwrap())?,
                request: index as i64,
                attempts: 1,
                continuation: "none".into(),
                invalidation: "provider-not-reported".into(),
                prompt_cache_key: "fixture-private-cache".into(),
                cache_read_reported: None,
                tokens: session::Document::new(ycoding_schema::parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap())?,
                cost,
                timing: None,
                time_created,
                outcome: None,
            })?;
        }
        Ok(())
    }).unwrap().wait().unwrap();
    }
}

fn put_session_requests(store: &ycoding_store::Store, rows: Vec<(&'static str, Option<f64>, i64)>) {
    use ycoding_store::{project, resources, session};
    store.submit(move |tx| {
        project::ProjectTable::insert(tx,&project::Project { id: "p".into(),worktree: "".into(),vcs: None,name: None,icon_url: None,icon_url_override: None,icon_color: None,time_created: 0,time_updated: 0,time_initialized: None,sandboxes: vec![],commands: None })?;
        session::SessionTable::insert(tx,&session::Session { id: "s".into(),project_id: "p".into(),workspace_id: None,parent_id: None,fork_session_id: None,fork_message_id: None,fork_seq: None,directory: "".into(),path: None,title: "".into(),cost: 0.0,tokens_input: 0,tokens_output: 0,tokens_reasoning: 0,tokens_cache_read: 0,tokens_cache_write: 0,revert: None,permission: None,autonomy: None,autonomy_revision: 0,orchestration_revision: 0,agent: None,model: None,profile_binding: None,daybreak: None,time_created: 0,time_updated: 0,time_archived: None,time_active: None,time_pinned: None,time_suspended: None, usage_pruned_through: None, origin: None, scope: "bound".into() })?;
        for (index,(provider,cost,time_created)) in rows.into_iter().enumerate() {
            resources::RequestTable::insert(tx,&resources::Request { id: format!("request-{index}").into(),session_id: "s".into(),input_id: None,assistant_message_id: None,connection_identity_digest: None,source: "step".into(),agent: "fixture".into(),model: session::Document::from_domain(&ycoding_schema::model::Ref { id: "m".into(),provider_id: provider::Id(provider.into()),variant: None,profile: None })?,route_id: "fixture".into(),prompt_cache_key: "fixture-private-cache".into(),system_digest: "fixture-private-system".into(),tool_digest: "fixture-private-tools".into(),request: index as i64,attempts: 1,invalidation: "provider-not-reported".into(),continuation: "none".into(),cache_read_reported: None,timing: None,cost,tokens: session::Document::new(ycoding_schema::parse_json(r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#).unwrap())?,time_created, usage_anchor: None, outcome: None })?;
        }
        Ok(())
    }).unwrap().wait().unwrap();
}

fn spend(store: &ycoding_store::Store) -> Vec<(String, Option<f64>)> {
    use ycoding_store::{TableSpec, resources, usage_cells};
    let _reports = report_support::start(store.client());
    let views = ycoding_core::usage_view::Service::new(
        ycoding_core::session::store::Service::new(store.client()),
        None,
    );
    while !ycoding_store::usage_cells::maintain(&store.client()).unwrap() {}
    while store.client().analytics().unwrap().maintain().unwrap()
        == ycoding_store::analytics::Maintenance::Pending
    {}
    assert!(views.publish().unwrap());
    let statement = store.read_statement(10_000);
    let snapshots =
        ycoding_core::resources::model::quota::local_spend_from_store(statement.client(), NOW)
            .unwrap();
    let usage = statement.usage();
    assert!(usage.rows <= usage.work && usage.work <= 10_000);
    for name in [
        usage_cells::LeafTable::NAME,
        resources::UsageAnalyticsRequestTable::NAME,
        resources::RequestTable::NAME,
    ] {
        assert_eq!(
            usage.tables.get(name),
            None,
            "local spend read visited {name}"
        );
    }
    if !snapshots.is_empty() {
        assert!(
            usage
                .tables
                .get(usage_cells::CellTable::NAME)
                .is_some_and(|rows| *rows > 0)
        );
    }
    snapshots
        .iter()
        .map(|s| (s.provider_id.0.to_utf8().unwrap(), s.windows[0].used))
        .collect()
}

fn expected() -> Vec<(String, Option<f64>)> {
    vec![
        ("anthropic".to_owned(), Some(0.0)),
        ("openai".to_owned(), Some(3.0)),
        (
            ycoding_core::resources::model::UPSTREAM_PROVIDER_ID.to_owned(),
            Some(10.0),
        ),
        ("opencode-go".to_owned(), Some(10.0)),
        ("xai".to_owned(), Some(10.0)),
    ]
}

#[test]
fn local_spend_reads_usage_analytics_rows_without_a_retained_session_or_request_mutation() {
    use ycoding_store::{resources, session};
    let store = store();
    put_analytics(&store, analytics_rows());
    let scan = || {
        store
            .snapshot()
            .unwrap()
            .scan::<resources::UsageAnalyticsRequestTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128,
            )
            .unwrap()
    };
    let before = scan();
    assert_eq!(before.len(), analytics_rows().len());
    assert!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::SessionTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                1
            )
            .unwrap()
            .is_empty()
    );
    assert_eq!(spend(&store), expected());
    assert!(!format!("{:?}", spend(&store)).contains("fixture-private"));
    assert_eq!(scan(), before);
    assert!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::SessionTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                1
            )
            .unwrap()
            .is_empty()
    );
}

#[test]
fn local_spend_ignores_session_request_rows_when_no_analytics_fact_exists() {
    let store = store();
    put_session_requests(&store, analytics_rows());
    assert!(spend(&store).is_empty());
}

#[test]
fn local_spend_reads_the_analytics_ledger_exactly_once_when_session_rows_diverge() {
    use ycoding_store::{resources, session};
    let store = store();
    put_session_requests(
        &store,
        analytics_rows()
            .into_iter()
            .map(|(provider, cost, time)| (provider, cost.map(|cost| cost * 100.0 + 1.0), time))
            .collect(),
    );
    put_analytics(&store, analytics_rows());
    let sessions = store
        .snapshot()
        .unwrap()
        .scan::<session::SessionTable>(std::ops::Bound::Unbounded, std::ops::Bound::Unbounded, 8)
        .unwrap();
    let requests = store
        .snapshot()
        .unwrap()
        .scan::<resources::RequestTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            128,
        )
        .unwrap();
    assert_eq!(spend(&store), expected());
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<session::SessionTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                8
            )
            .unwrap(),
        sessions
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<resources::RequestTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                128
            )
            .unwrap(),
        requests
    );
}

#[test]
fn retained_mixed_sign_requests_keep_today_positive_spend_exact() {
    use std::ops::Bound;
    use ycoding_store::{TableSpec, usage_cells::LeafTable};
    let store = store();
    let mut rows = (0..21_844)
        .map(|index| {
            (
                "openai",
                Some(if index % 2 == 0 { 3.0 } else { -1.0 }),
                NOW - 2 * DAY,
            )
        })
        .collect::<Vec<_>>();
    rows.extend([("openai", Some(3.0), NOW), ("openai", Some(-1.0), NOW)]);
    put_analytics(&store, rows);
    let snapshot = store.snapshot().unwrap();
    let mut after = None;
    let mut retained = 0;
    loop {
        let page = snapshot
            .scan::<LeafTable>(
                after.as_deref().map_or(Bound::Unbounded, Bound::Excluded),
                Bound::Unbounded,
                1024,
            )
            .unwrap();
        if page.is_empty() {
            break;
        }
        after = page.last().map(LeafTable::primary_key);
        retained += page
            .iter()
            .filter(|leaf| leaf.family == "backend".into())
            .count();
    }
    assert_eq!(retained, 65_538);
    drop(snapshot);
    assert_eq!(spend(&store), [("openai".to_owned(), Some(3.0))]);
}

#[test]
fn negative_and_missing_recorded_costs_stay_absent_but_recorded_zero_is_measured() {
    let store = store();
    put_analytics(
        &store,
        vec![
            ("anthropic", Some(-1.0), NOW),
            ("openai", None, NOW),
            ("opencode-go", Some(0.0), NOW),
            ("meta", Some(5.0), NOW),
        ],
    );
    assert_eq!(spend(&store), [("opencode-go".to_owned(), Some(0.0))]);
}

#[test]
fn deleting_the_final_recorded_zero_removes_local_spend_presence() {
    use ycoding_store::{KeyPart, resources::UsageAnalyticsRequestTable, tuple_key};
    let store = store();
    put_analytics(
        &store,
        vec![
            ("openai", Some(0.0), NOW),
            ("openai", Some(0.0), NOW),
            ("openai", Some(-1.0), NOW),
        ],
    );
    assert_eq!(spend(&store), [("openai".to_owned(), Some(0.0))]);
    store
        .submit(|tx| {
            UsageAnalyticsRequestTable::delete(
                tx,
                &tuple_key(&[KeyPart::String(&"analytics-0".into())]),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(spend(&store), [("openai".to_owned(), Some(0.0))]);
    store
        .submit(|tx| {
            UsageAnalyticsRequestTable::delete(
                tx,
                &tuple_key(&[KeyPart::String(&"analytics-1".into())]),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    assert!(spend(&store).is_empty());
}

#[test]
fn catalog_only_price_corrections_do_not_fabricate_recorded_local_spend() {
    use ycoding_core::session::usage_read::Pricing;
    use ycoding_schema::{DomainDecode, model, parse_json};
    let store = store();
    put_analytics(&store, vec![("openai", None, NOW)]);
    let _reports = report_support::start(store.client());
    let views = ycoding_core::usage_view::Service::new(
        ycoding_core::session::store::Service::new(store.client()),
        Some(std::sync::Arc::new(|_| {
            Ok(Some(Pricing {
                provider: vec![
                    model::Cost::decode(
                        &parse_json(r#"{"input":1000000,"output":0,"cache":{"read":0,"write":0}}"#)
                            .unwrap(),
                    )
                    .unwrap(),
                ],
                router: vec![],
            }))
        })),
    );
    while !ycoding_store::usage_cells::maintain(&store.client()).unwrap() {}
    while store.client().analytics().unwrap().maintain().unwrap()
        == ycoding_store::analytics::Maintenance::Pending
    {}
    assert!(views.publish().unwrap());
    assert!(
        ycoding_core::resources::model::quota::local_spend_from_store(&store.client(), NOW)
            .unwrap()
            .is_empty()
    );
}
