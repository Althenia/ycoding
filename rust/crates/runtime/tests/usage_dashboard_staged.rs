#[path = "../../core/tests/report_support/prepared.rs"]
mod prepared_support;
mod support;

use prost::Message;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use support::{machine, operation, services, world};
use ycoding_core::{
    usage_dashboard, usage_view,
    ycoding_store::{Metadata, Options, Store, native},
};
use ycoding_protocol::{
    domain_json::{self, Domain},
    v5,
};
use ycoding_runtime::{Environment, LocalAuth, Settled, Staging, Subscriptions, standard};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_stage_returns_preparing_without_provider_resolution_or_pricing_even_on_refresh() {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([86; 16], 1),
    )
    .unwrap();
    let provider_reads = Arc::new(AtomicUsize::new(0));
    let pricing_reads = Arc::new(AtomicUsize::new(0));
    let provider_calls = provider_reads.clone();
    let pricing_calls = pricing_reads.clone();
    let mut configured = services(LocalAuth::disabled(), true);
    let core = configured.core.as_mut().unwrap();
    core.provider_usage = Some(Arc::new(move |_| {
        provider_calls.fetch_add(1, Ordering::SeqCst);
        Err("Provider resolution is forbidden during a staged read".into())
    }));
    core.usage_dashboard = Some(usage_dashboard::Service::new(
        usage_view::Service::new(
            ycoding_core::session::store::Service::new(store.client()),
            Some(Arc::new(move |_| {
                pricing_calls.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            })),
        ),
        core.generation.clone(),
        Arc::new(|| (1, 1)),
    ));
    let environment = Arc::new(Environment {
        services: configured,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Staging::default(),
    });
    let descriptor = operation("usage.dashboard");
    let dispatcher = standard().unwrap();
    let mut outcomes = Vec::new();
    for (request_id, input) in [
        ("staged-dashboard-read", Domain::Object(vec![])),
        (
            "staged-dashboard-refresh",
            Domain::Object(vec![(
                "refresh".encode_utf16().collect(),
                Domain::Bool(true),
            )]),
        ),
    ] {
        let payload = domain_json::encode(
            &descriptor.request_type,
            &Domain::Object(vec![("payload".encode_utf16().collect(), input)]),
            65_536,
        )
        .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            dispatcher.invoke(
                environment.clone(),
                "staged-dashboard-client".into(),
                v5::Request {
                    request_id: request_id.into(),
                    operation_id: descriptor.operation_id,
                    scope: machine(),
                    payload,
                },
            ),
        )
        .await
        .expect("staged read exceeded its time bound")
        .unwrap();
        let Settled::Result(result) = result else {
            panic!("a staged dashboard must settle inline");
        };
        outcomes.push(result.outcome);
    }
    assert_eq!(provider_reads.load(Ordering::SeqCst), 0);
    assert_eq!(pricing_reads.load(Ordering::SeqCst), 0);
    for outcome in outcomes {
        let Some(v5::result::Outcome::Success(payload)) = outcome else {
            panic!("missing staged data must return Preparing, got {outcome:?}");
        };
        let result = v5::UsageDashboardResult::decode(payload.payload.as_slice()).unwrap();
        let data = domain_json::decode(
            "ycoding.v5.UsageDashboard_Info",
            &result.data.encode_to_vec(),
        )
        .unwrap();
        assert_eq!(
            data,
            Domain::Object(vec![(
                "status".encode_utf16().collect(),
                Domain::Text("preparing".encode_utf16().collect())
            )])
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dashboard_waits_for_matching_accounting_while_quota_only_reads_remain_available() {
    use ycoding_core::{
        resources::{credential, model::quota},
        session::store::Service,
        ycoding_schema::{DomainDecode, location, parse_json, provider, schema::NonNegativeInt},
    };
    let store = world().store.clone();
    let views = usage_view::Service::new(Service::new(store.clone()), None);
    let unprepared_store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([88; 16], 1),
    )
    .unwrap();
    let unprepared_views = usage_view::Service::new(Service::new(unprepared_store.client()), None);
    let unprepared = Arc::new(
        quota::Service::new(
            credential::Service::new(store.clone()),
            quota::Endpoints::default(),
        )
        .unwrap()
        .with_store(unprepared_store.client()),
    );
    let quota = Arc::new(
        quota::Service::new(
            credential::Service::new(store.clone()),
            quota::Endpoints::default(),
        )
        .unwrap()
        .with_store(store.clone()),
    );
    let reference =
        location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap()).unwrap();
    assert!(
        unprepared
            .publish(
                &unprepared_views,
                &reference,
                1,
                &[provider::Id("muse".into())],
                NonNegativeInt::new(1000).unwrap()
            )
            .await
            .unwrap()
    );
    assert!(
        unprepared
            .prepared(&reference, 1)
            .unwrap()
            .unwrap()
            .accounting_revision
            .is_none()
    );
    let mut configured = services(LocalAuth::disabled(), true);
    let core = configured.core.as_mut().unwrap();
    let _location = core
        .locations
        .location(reference.directory.as_lossless(), None)
        .unwrap();
    core.platform_default_location = Some(reference.clone());
    let without_store = Arc::new(
        quota::Service::new(
            credential::Service::new(store.clone()),
            quota::Endpoints::default(),
        )
        .unwrap(),
    );
    let closed_store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([87; 16], 1),
    )
    .unwrap();
    let closed = Arc::new(
        quota::Service::new(
            credential::Service::new(store.clone()),
            quota::Endpoints::default(),
        )
        .unwrap()
        .with_store(closed_store.client()),
    );
    closed_store.shutdown().unwrap();
    let quotas = [quota.clone(), without_store, closed, unprepared];
    let active = Arc::new(AtomicUsize::new(0));
    core.provider_usage = Some(Arc::new({
        let quotas = quotas.clone();
        let active = active.clone();
        move |_| {
            Ok(ycoding_runtime::ProviderUsageServices {
                quota: quotas[active.load(Ordering::SeqCst)].clone(),
                generation: 1,
            })
        }
    }));
    let dashboard = usage_dashboard::Service::new(
        views.clone(),
        core.generation.clone(),
        Arc::new(|| (1000, 0)),
    );
    let input =
        ycoding_core::ycoding_schema::usage_dashboard::Input::decode(&parse_json("{}").unwrap())
            .unwrap();
    let _ = dashboard.read(
        ycoding_core::ycoding_schema::usage_dashboard::Quota::Preparing,
        &input,
    );
    core.usage_dashboard = Some(dashboard.clone());
    prepared_support::publish(&store, &views);
    for quota in &quotas[1..3] {
        assert!(
            quota
                .publish(
                    &views,
                    &reference,
                    1,
                    &[provider::Id("muse".into())],
                    NonNegativeInt::new(1000).unwrap()
                )
                .await
                .unwrap()
        );
        assert!(
            quota
                .prepared(&reference, 1)
                .unwrap()
                .unwrap()
                .accounting_revision
                .is_none()
        );
    }
    let environment = Arc::new(Environment {
        services: configured,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Staging::default(),
    });
    let dispatcher = standard().unwrap();
    for (phase, index) in [
        ("unprepared", 3),
        ("absent", 1),
        ("closed", 2),
        ("matched", 0),
        ("invalidated", 0),
    ] {
        active.store(index, Ordering::SeqCst);
        if phase == "matched" {
            assert!(
                quota
                    .publish(
                        &views,
                        &reference,
                        1,
                        &[provider::Id("muse".into())],
                        NonNegativeInt::new(1000).unwrap()
                    )
                    .await
                    .unwrap()
            );
        } else if phase == "invalidated" {
            views.catalog_changed(Some(&reference), || {});
            prepared_support::publish(&store, &views);
        }
        let descriptor = operation("usage.dashboard");
        let payload = domain_json::encode(
            &descriptor.request_type,
            &Domain::Object(vec![(
                "payload".encode_utf16().collect(),
                Domain::Object(vec![]),
            )]),
            65_536,
        )
        .unwrap();
        let Settled::Result(result) = dispatcher
            .invoke(
                environment.clone(),
                "staged-revision-client".into(),
                v5::Request {
                    request_id: format!("dashboard-{phase}"),
                    operation_id: descriptor.operation_id,
                    scope: machine(),
                    payload,
                },
            )
            .await
            .unwrap()
        else {
            panic!("dashboard must settle inline")
        };
        let Some(v5::result::Outcome::Success(payload)) = result.outcome else {
            panic!("dashboard read failed")
        };
        let result = v5::UsageDashboardResult::decode(payload.payload.as_slice()).unwrap();
        let Domain::Object(data) = domain_json::decode(
            "ycoding.v5.UsageDashboard_Info",
            &result.data.encode_to_vec(),
        )
        .unwrap() else {
            panic!("dashboard object expected")
        };
        assert_eq!(
            data.iter()
                .find(|(name, _)| name == &"status".encode_utf16().collect::<Vec<_>>())
                .unwrap()
                .1,
            Domain::Text(
                if matches!(phase, "matched" | "invalidated") {
                    "ready"
                } else {
                    "preparing"
                }
                .encode_utf16()
                .collect()
            ),
            "{phase}"
        );
        if phase == "invalidated" {
            let Domain::Object(quota) = &data
                .iter()
                .find(|(name, _)| name == &"quota".encode_utf16().collect::<Vec<_>>())
                .unwrap()
                .1
            else {
                panic!("quota object expected")
            };
            assert_eq!(
                quota
                    .iter()
                    .find(|(name, _)| name == &"status".encode_utf16().collect::<Vec<_>>())
                    .unwrap()
                    .1,
                Domain::Text("preparing".encode_utf16().collect())
            );
        }
        let descriptor = operation("providerUsage.get");
        let Settled::Result(result) = dispatcher
            .invoke(
                environment.clone(),
                "staged-revision-client".into(),
                v5::Request {
                    request_id: format!("quota-{phase}"),
                    operation_id: descriptor.operation_id,
                    scope: machine(),
                    payload: v5::ProviderUsageGetRequest {
                        params: v5::ProviderUsageGetRequestParams {
                            provider_id: support::text("muse"),
                        },
                        query: v5::ProviderUsageQuery {
                            location: None,
                            refresh: Some(false),
                        },
                    }
                    .encode_to_vec(),
                },
            )
            .await
            .unwrap()
        else {
            panic!("quota must settle inline")
        };
        if phase == "invalidated" {
            let Some(v5::result::Outcome::Error(error)) = result.outcome else {
                panic!("invalidated quota must be unavailable")
            };
            assert_eq!(error.type_name, "ycoding.v5.ServiceUnavailableError");
        } else {
            assert!(matches!(
                result.outcome,
                Some(v5::result::Outcome::Success(_))
            ));
        }
    }
    dashboard.shutdown().await.unwrap();
    for quota in quotas {
        quota.shutdown().await.unwrap();
    }
    unprepared_store.shutdown().unwrap();
}
