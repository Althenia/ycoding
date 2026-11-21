use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use ycoding_core::{generation_activity, session::store, usage_dashboard, usage_view};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, provider_request, usage_dashboard as domain,
};
use ycoding_store::{Metadata, Options, Store, native};

#[path = "report_support/demand.rs"]
mod demand_support;
#[path = "report_support/prepared.rs"]
mod prepared_support;
#[path = "report_support/mod.rs"]
mod report_support;

fn input(value: &str) -> domain::Input {
    domain::Input::decode(&parse_json(value).unwrap()).unwrap()
}

fn status(value: &impl DomainEncode) -> String {
    let JsonValue::Object(fields) = value.encode() else {
        panic!("object expected")
    };
    let Some(JsonValue::String(status)) = fields.get(&"status".into()) else {
        panic!("status expected")
    };
    status.to_utf8().unwrap()
}

#[test]
fn an_independent_presentation_producer_runs_while_another_waits() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([32; 16], 1),
    )
    .unwrap();
    let client = store.client();
    let _reports = report_support::start(client.clone());
    let views = usage_view::Service::new(store::Service::new(client.clone()), None);
    prepared_support::publish(&client, &views);
    let view = views.read_prepared(&[]).unwrap().unwrap();
    let value = ycoding_store::analytics::UsagePresentation {
        summary: Some(view.summary),
        reports: vec![],
        as_of: view.as_of,
        revision: view.revision,
        price_refs: vec![],
    };
    let handle = client.analytics().unwrap();
    let (independent_started, wait_for_independent) = std::sync::mpsc::channel();
    let first = value.clone();
    assert!(
        handle
            .presentation("a-held".into(), false, move || {
                wait_for_independent
                    .recv_timeout(Duration::from_secs(2))
                    .map_err(|_| {
                        ycoding_store::Error::Rejected("independent Usage producer did not start")
                    })?;
                Ok(first)
            })
            .unwrap()
            .is_none()
    );
    assert!(
        handle
            .presentation("b-independent".into(), false, move || {
                let _ = independent_started.send(());
                Ok(value)
            })
            .unwrap()
            .is_none()
    );

    handle.prepare_presentations().unwrap();

    for key in ["a-held", "b-independent"] {
        let ready = handle
            .presentation(key.into(), false, || panic!("ready value must be reused"))
            .unwrap()
            .unwrap();
        assert!(ready.summary.is_some());
    }
}

#[tokio::test]
async fn cold_dashboard_read_does_not_start_any_producer() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([31; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start_with(store.client(), false);
    let pricing_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let calls = pricing_calls.clone();
    let service = usage_dashboard::Service::new(
        usage_view::Service::new(
            store::Service::new(store.client()),
            Some(Arc::new(move |_| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(None)
            })),
        ),
        generation_activity::Service::new(0, 0),
        Arc::new(|| (1000, 0)),
    );
    assert!(!ycoding_store::usage_cells::ready(&store.snapshot().unwrap()).unwrap());
    for request in [
        input(r#"{"daily":{"group":"day"}}"#),
        input(r#"{"daily":{"group":"day"},"refresh":true}"#),
    ] {
        assert_eq!(
            status(&service.read(domain::Quota::Preparing, &request)),
            "preparing"
        );
    }
    service.shutdown().await.unwrap();
    assert!(!ycoding_store::usage_cells::ready(&store.snapshot().unwrap()).unwrap());
    assert_eq!(pricing_calls.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
async fn reads_never_wait_on_preparation_or_quota_and_reports_equal_the_accounting_oracle() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([8; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let sessions = store::Service::new(store.client());
    let views = usage_view::Service::new(sessions.clone(), None);
    let service = usage_dashboard::Service::new(
        views.clone(),
        generation_activity::Service::new(0, 0),
        Arc::new(|| (1000, 1_000_000_000)),
    );
    let request = input(r#"{"daily":{"group":"day"},"monthly":{"group":"model"}}"#);
    let before = Instant::now();
    assert_eq!(
        status(&service.read(domain::Quota::Preparing, &request)),
        "preparing"
    );
    assert!(before.elapsed() < Duration::from_millis(100));
    prepared_support::publish(&store.client(), &views);
    service.read(domain::Quota::Preparing, &request);
    store
        .client()
        .analytics()
        .unwrap()
        .prepare_presentations()
        .unwrap();
    let result = service.read(domain::Quota::Preparing, &request).encode();
    let JsonValue::Object(fields) = result else {
        panic!("object expected")
    };
    assert_eq!(
        fields.get(&"status".into()),
        Some(&JsonValue::String("ready".into()))
    );
    assert!(fields.get(&"breakdown".into()).is_none());
    let daily =
        provider_request::ReportInput::decode(&parse_json(r#"{"group":"day"}"#).unwrap()).unwrap();
    assert_eq!(
        fields.get(&"daily".into()),
        Some(
            &{
                demand_support::prepare(&store.client(), None, std::slice::from_ref(&daily))
                    .unwrap();
                sessions.usage_report_all(&daily)
            }
            .unwrap()
            .encode()
        )
    );
    let JsonValue::Object(quota) = fields.get(&"quota".into()).unwrap() else {
        panic!("quota expected")
    };
    assert_eq!(
        quota.get(&"status".into()),
        Some(&JsonValue::String("preparing".into()))
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn failures_are_data_and_refresh_never_repairs_or_retires_prepared_results() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let views = usage_view::Service::new(store::Service::new(store.client()), None);
    let service = usage_dashboard::Service::new(
        views.clone(),
        generation_activity::Service::new(0, 0),
        Arc::new(|| (1000, 0)),
    );
    let request = input(r#"{"daily":{"group":"day"}}"#);
    assert_eq!(
        status(&service.read(domain::Quota::Preparing, &request)),
        "preparing"
    );
    store.client().analytics().unwrap().fail_usage().unwrap();
    assert_eq!(
        status(&service.read(domain::Quota::Preparing, &request)),
        "error"
    );
    prepared_support::publish(&store.client(), &views);
    views.invalidate();
    assert_eq!(
        status(&service.read(domain::Quota::Preparing, &request)),
        "preparing"
    );
    let refresh = input(r#"{"daily":{"group":"day"},"refresh":true}"#);
    assert_eq!(
        status(&service.read(domain::Quota::Preparing, &refresh)),
        "preparing"
    );
    prepared_support::publish(&store.client(), &views);
    service.read(domain::Quota::Preparing, &request);
    store
        .client()
        .analytics()
        .unwrap()
        .prepare_presentations()
        .unwrap();
    let before = service.read(domain::Quota::Preparing, &request).encode();
    assert_eq!(
        service.read(domain::Quota::Preparing, &refresh).encode(),
        before
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn warm_dashboard_reads_have_a_representative_bounded_cost() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([10; 16], 1),
    )
    .unwrap();
    let _reports = report_support::start(store.client());
    let views = usage_view::Service::new(store::Service::new(store.client()), None);
    prepared_support::publish(&store.client(), &views);
    let service = usage_dashboard::Service::new(
        views,
        generation_activity::Service::new(0, 0),
        Arc::new(|| (1000, 0)),
    );
    let request = input(
        r#"{"daily":{"group":"day"},"monthly":{"group":"model"},"breakdown":{"group":"provider-profile-model","limit":25}}"#,
    );
    service.read(domain::Quota::Preparing, &request);
    store
        .client()
        .analytics()
        .unwrap()
        .prepare_presentations()
        .unwrap();
    let start = Instant::now();
    for _ in 0..1000 {
        assert_eq!(
            status(&service.read(domain::Quota::Preparing, &request)),
            "ready"
        );
    }
    assert!(start.elapsed() < Duration::from_secs(2));
    service.shutdown().await.unwrap();
}
