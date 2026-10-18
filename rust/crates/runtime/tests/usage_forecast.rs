mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::{Message, Name};
use remote_derived_support::{Fixture, expired_peer, now, world};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use support::{machine, operation, session_scope, text, units, wire::location_scope};
use tokio::net::TcpListener;
use ycoding_core::{
    resources::model::{account_identity, quota},
    ycoding_schema::{parse_json, provider, provider_usage, schema::NonNegativeInt},
    ycoding_store::{resources, session::Document},
};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, ProviderUsageServices, Settled,
    connector::{Credential, Enrolled, Peer},
    standard,
};

const MINUTE: i64 = 60_000;
const BACKEND: i32 = 1;
const LOCATION: i32 = 2;

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "forecast-test".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

async fn request(
    environment: Arc<Environment>,
    scope: v5::Scope,
    query: v5::ProviderUsageForecastRequestQuery,
    peer: Option<&Peer>,
) -> v5::TypedPayload {
    let dispatcher = standard().unwrap();
    let request = v5::Request {
        request_id: "forecast-request".into(),
        operation_id: operation("providerUsage.forecast").operation_id,
        scope,
        payload: v5::ProviderUsageForecastRequest { query }.encode_to_vec(),
    };
    let settled = match peer {
        Some(peer) => {
            dispatcher
                .invoke_remote(environment, "forecast-connection".into(), peer, request)
                .await
        }
        None => {
            dispatcher
                .invoke(environment, "forecast-connection".into(), request)
                .await
        }
    };
    let Some(Settled::Result(result)) = settled else {
        panic!("missing inline forecast settlement")
    };
    match result.outcome.unwrap() {
        v5::result::Outcome::Success(payload) | v5::result::Outcome::Error(payload) => payload,
        _ => panic!("unexpected asset"),
    }
}

fn query(
    local_scope: i32,
    location: Option<v5::ProviderUsageForecastRequestQueryLocation>,
) -> v5::ProviderUsageForecastRequestQuery {
    v5::ProviderUsageForecastRequestQuery {
        location,
        local_scope,
    }
}

fn success(payload: v5::TypedPayload) -> v5::ProviderUsageForecastResult {
    assert_eq!(
        payload.type_name,
        v5::ProviderUsageForecastResult::full_name(),
        "{:?}",
        v5::InvalidRequestError::decode(payload.payload.as_slice())
    );
    decode_strict(&payload.payload).unwrap()
}

fn invalid(payload: v5::TypedPayload) -> v5::InvalidRequestError {
    assert!(
        operation("providerUsage.forecast")
            .error_types
            .contains(&payload.type_name),
        "unexpected forecast response: {}",
        payload.type_name
    );
    assert_eq!(payload.type_name, v5::InvalidRequestError::full_name());
    decode_strict(&payload.payload).unwrap()
}

fn rated(result: &v5::ProviderUsageForecastResult, prefix: &str) -> BTreeSet<String> {
    result
        .data
        .local_rates
        .as_ref()
        .unwrap()
        .items
        .iter()
        .filter_map(|rate| rate.model_id.as_ref().map(units))
        .filter(|id| id.starts_with(prefix))
        .collect()
}

fn fact(id: &str, directory: &str, model: &str, time: i64) -> resources::UsageAnalyticsRequest {
    resources::UsageAnalyticsRequest {
        id: id.into(),
        session_id: "ses_forecast_private".into(),
        project_id: "prj_forecast_private".into(),
        directory: directory.into(),
        workspace_id: None,
        session_updated: time,
        agent: "build".into(),
        source: "step".into(),
        model: Document::new(
            parse_json(&format!(r#"{{"providerID":"anthropic","id":"{model}"}}"#)).unwrap(),
        )
        .unwrap(),
        usage_anchor: None,
        task_path: Document::new(parse_json("[]").unwrap()).unwrap(),
        request: 1,
        attempts: 1,
        continuation: "full".into(),
        invalidation: "first-request".into(),
        prompt_cache_key: "forecast-private-namespace".into(),
        cache_read_reported: None,
        tokens: Document::new(
            parse_json(r#"{"input":600,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                .unwrap(),
        )
        .unwrap(),
        cost: Some(0.25),
        timing: None,
        time_created: time,
    }
}

struct Seeded {
    quota: Arc<quota::Service>,
    account: String,
}

async fn seed(prefix: &str, here: &str, label: &str) -> Seeded {
    let time = now();
    let facts = [
        fact(
            &format!("fact_{prefix}here"),
            here,
            &format!("{prefix}here"),
            time - 10 * MINUTE,
        ),
        fact(
            &format!("fact_{prefix}elsewhere"),
            "/forecast/elsewhere",
            &format!("{prefix}elsewhere"),
            time - 2 * MINUTE,
        ),
    ];
    world()
        .store
        .submit(move |tx| {
            facts
                .iter()
                .try_for_each(|row| resources::UsageAnalyticsRequestTable::insert(tx, row))
        })
        .unwrap()
        .await
        .unwrap();
    let credentials = world().core.credentials.clone();
    let secret = resources::Secret::new(
        parse_json(r#"{"type":"key","key":"synthetic-forecast-key"}"#).unwrap(),
    )
    .unwrap();
    let saved = credentials
        .create(
            format!("private-forecast-muse-{prefix}").as_str().into(),
            "muse".into(),
            Some(label.into()),
            secret.clone(),
            1,
        )
        .await
        .unwrap();
    credentials
        .create(
            format!("private-forecast-router-{prefix}").as_str().into(),
            "openrouter".into(),
            Some(label.into()),
            secret,
            1,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let unreachable = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let quota = Arc::new(
        quota::Service::new(
            credentials,
            quota::Endpoints(BTreeMap::from([("openrouter".into(), unreachable)])),
        )
        .unwrap()
        .with_store(world().store.clone()),
    );
    let account = account_identity(&saved);
    quota
        .observe(
            provider_usage::Observation {
                provider_id: provider::Id("muse".into()),
                label: "Muse (Meta)".into(),
                source: "response_stream".into(),
                stability: "observed".into(),
                observed_at: NonNegativeInt::new(time).unwrap(),
                windows: vec![provider_usage::Window {
                    id: "five-hour".into(),
                    label: "5-hour window".into(),
                    unit: "percent".into(),
                    used: Some(40.0),
                    limit: None,
                    remaining: None,
                    unlimited: None,
                    reset_at: Some(NonNegativeInt::new(time + 60 * MINUTE).unwrap()),
                    period_seconds: Some(NonNegativeInt::new(18000).unwrap()),
                }],
            },
            Some(account.clone()),
        )
        .unwrap();
    Seeded {
        quota,
        account: account.as_str().unwrap().to_owned(),
    }
}

fn served(fixture: &Fixture, quota: Option<Arc<quota::Service>>) -> Arc<Environment> {
    let mut environment = fixture.environment(true);
    let core = Arc::get_mut(&mut environment)
        .unwrap()
        .services
        .core
        .as_mut()
        .unwrap();
    core.provider_usage = None;
    if let Some(quota) = quota {
        core.provider_usage = Some(Arc::new(move |_| {
            Ok(ProviderUsageServices {
                quota: quota.clone(),
                providers: ["muse", "openrouter"]
                    .map(|id| provider::Id(id.into()))
                    .to_vec(),
            })
        }));
    }
    environment
}

fn assert_private(result: &v5::ProviderUsageForecastResult, seeded: &Seeded) {
    let payload = String::from_utf8_lossy(&result.encode_to_vec()).into_owned();
    for private in [
        seeded.account.as_str(),
        "private-forecast",
        "synthetic-forecast-key",
        "forecast-private-namespace",
        "ses_forecast_private",
        "prj_forecast_private",
    ] {
        assert!(!payload.contains(private), "{private}");
    }
}

fn assert_quotas(result: &v5::ProviderUsageForecastResult, label: &str) {
    let quotas = &result.data.quotas.as_ref().unwrap().items;
    let muse = quotas
        .iter()
        .find(|quota| {
            units(&quota.provider_id) == "muse"
                && quota.profile.as_ref().map(units).as_deref() == Some(label)
        })
        .unwrap();
    assert_eq!(units(&muse.window_id), "five-hour");
    assert_eq!((muse.unit, muse.source, muse.stability), (1, 6, 3));
    assert_eq!((muse.state, muse.evidence), (2, 3));
    assert_eq!(
        (muse.rate_per_hour, muse.exhaustion_at, muse.method),
        (None, None, None)
    );
    assert!(
        quotas
            .iter()
            .all(|quota| units(&quota.provider_id) != "openrouter")
    );
}

#[test]
fn forecast_is_a_private_location_read_with_remote_machine_and_session_scopes() {
    let descriptor = operation("providerUsage.forecast");
    assert_eq!(descriptor.operation_id, 2063);
    assert_eq!(descriptor.scope, v5::ScopeKind::Location as i32);
    assert_eq!(
        descriptor.result_type,
        v5::ProviderUsageForecastResult::full_name()
    );
    assert_eq!(
        descriptor.request_type,
        v5::ProviderUsageForecastRequest::full_name()
    );
    for error in [
        v5::ServiceUnavailableError::full_name(),
        v5::UnauthorizedError::full_name(),
        v5::InvalidRequestError::full_name(),
    ] {
        assert!(descriptor.error_types.contains(&error), "{error}");
    }
    for role in [
        v5::PeerRole::LocalClient,
        v5::PeerRole::RemoteClient,
        v5::PeerRole::Relay,
    ] {
        assert!(descriptor.roles.contains(&(role as i32)));
    }
    for role in [v5::PeerRole::RemoteClient, v5::PeerRole::Relay] {
        let scopes = &descriptor
            .role_scopes
            .iter()
            .find(|entry| entry.role == role as i32)
            .unwrap()
            .scopes;
        assert_eq!(
            scopes.iter().copied().collect::<BTreeSet<_>>(),
            BTreeSet::from([v5::ScopeKind::Machine as i32, v5::ScopeKind::Session as i32])
        );
    }
    assert_eq!(descriptor.mutation, v5::MutationClass::Read as i32);
    assert_eq!(descriptor.paging, v5::Paging::Unpaged as i32);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_forecast_preserves_whole_window_pace_and_its_bounded_exhaustion_time() {
    let fixture = Fixture::new().await;
    let seeded = seed("forecast-pace-", &fixture.directory, "PaceWork").await;
    let time = now();
    let reset = time + 150 * MINUTE;
    seeded
        .quota
        .observe(
            provider_usage::Observation {
                provider_id: provider::Id("muse".into()),
                label: "Muse (Meta)".into(),
                source: "response_stream".into(),
                stability: "observed".into(),
                observed_at: NonNegativeInt::new(time).unwrap(),
                windows: vec![provider_usage::Window {
                    id: "window".into(),
                    label: "Window".into(),
                    unit: "percent".into(),
                    used: Some(60.0),
                    limit: Some(100.0),
                    remaining: None,
                    unlimited: None,
                    reset_at: Some(NonNegativeInt::new(reset).unwrap()),
                    period_seconds: Some(NonNegativeInt::new(18000).unwrap()),
                }],
            },
            Some(seeded.account.as_str().into()),
        )
        .unwrap();
    let result = success(
        request(
            served(&fixture, Some(seeded.quota.clone())),
            location_scope(&fixture.directory),
            query(BACKEND, None),
            None,
        )
        .await,
    );
    let quota = result
        .data
        .quotas
        .as_ref()
        .unwrap()
        .items
        .iter()
        .find(|quota| units(&quota.provider_id) == "muse" && units(&quota.window_id) == "window")
        .unwrap();
    let pace = quota.pace.as_ref().unwrap();
    assert_eq!(
        pace.verdict,
        v5::UsageForecastPaceVerdict::UsageforecastPaceVerdictWillRunOut as i32
    );
    assert!(pace.projected_used_at_reset > 100.0);
    assert!((result.data.as_of + 1..reset as u64).contains(&pace.exhaustion_at.unwrap()));
    assert_private(&result, &seeded);
    seeded.quota.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_forecast_reads_backend_or_location_rates_and_bound_quotas_without_account_identity()
{
    let fixture = Fixture::new().await;
    let seeded = seed("forecast-local-", &fixture.directory, "LocalWork").await;
    let environment = served(&fixture, Some(seeded.quota.clone()));
    let before = now();
    let backend = success(
        request(
            environment.clone(),
            location_scope(&fixture.directory),
            query(BACKEND, None),
            None,
        )
        .await,
    );
    let after = now();
    assert_eq!(units(&backend.location.directory), fixture.directory);
    assert_eq!(backend.data.local_scope, BACKEND);
    assert!((before as u64..=after as u64).contains(&backend.data.as_of));
    assert_eq!(
        rated(&backend, "forecast-local-"),
        BTreeSet::from([
            "forecast-local-elsewhere".to_owned(),
            "forecast-local-here".to_owned()
        ])
    );
    let here = backend
        .data
        .local_rates
        .as_ref()
        .unwrap()
        .items
        .iter()
        .find(|rate| rate.model_id.as_ref().map(units).as_deref() == Some("forecast-local-here"))
        .unwrap();
    assert_eq!(units(&here.provider_id), "anthropic");
    assert_eq!(
        (
            here.coverage.priced_requests,
            here.coverage.unpriced_requests
        ),
        (1, 0)
    );
    assert_quotas(&backend, "LocalWork");
    assert_private(&backend, &seeded);

    let location = success(
        request(
            environment.clone(),
            location_scope(&fixture.directory),
            query(
                LOCATION,
                Some(v5::ProviderUsageForecastRequestQueryLocation {
                    directory: Some(text(&fixture.directory)),
                    workspace: None,
                }),
            ),
            None,
        )
        .await,
    );
    assert_eq!(units(&location.location.directory), fixture.directory);
    assert_eq!(location.data.local_scope, LOCATION);
    assert_eq!(
        rated(&location, "forecast-local-"),
        BTreeSet::from(["forecast-local-here".to_owned()])
    );
    assert_quotas(&location, "LocalWork");
    assert_private(&location, &seeded);

    invalid(
        request(
            environment,
            location_scope(&fixture.directory),
            query(
                BACKEND,
                Some(v5::ProviderUsageForecastRequestQueryLocation {
                    directory: Some(text("/forecast/elsewhere")),
                    workspace: None,
                }),
            ),
            None,
        )
        .await,
    );
    let unavailable = request(
        served(&fixture, None),
        location_scope(&fixture.directory),
        query(BACKEND, None),
        None,
    )
    .await;
    assert_eq!(
        unavailable.type_name,
        v5::ServiceUnavailableError::full_name()
    );
    seeded.quota.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_forecast_takes_location_from_backend_scope_and_rejects_caller_location_scope_mismatch_and_expired_peers()
 {
    let fixture = Fixture::new().await;
    let seeded = seed("forecast-remote-", &fixture.directory, "RemoteWork").await;
    let environment = served(&fixture, Some(seeded.quota.clone()));
    let peer = peer();
    let expected = std::env::current_dir().unwrap();

    let machine_result = success(
        request(
            environment.clone(),
            machine(),
            query(BACKEND, None),
            Some(&peer),
        )
        .await,
    );
    assert_eq!(
        units(&machine_result.location.directory),
        expected.to_str().unwrap()
    );
    assert!(machine_result.location.workspace_id.is_none());
    assert_eq!(machine_result.data.local_scope, BACKEND);
    assert_eq!(
        rated(&machine_result, "forecast-remote-"),
        BTreeSet::from([
            "forecast-remote-elsewhere".to_owned(),
            "forecast-remote-here".to_owned()
        ])
    );
    assert_quotas(&machine_result, "RemoteWork");
    assert_private(&machine_result, &seeded);

    let session_result = success(
        request(
            environment.clone(),
            session_scope(&fixture.root),
            query(LOCATION, None),
            Some(&peer),
        )
        .await,
    );
    assert_eq!(units(&session_result.location.directory), fixture.directory);
    assert_eq!(session_result.data.local_scope, LOCATION);
    assert_eq!(
        rated(&session_result, "forecast-remote-"),
        BTreeSet::from(["forecast-remote-here".to_owned()])
    );
    assert_quotas(&session_result, "RemoteWork");
    assert_private(&session_result, &seeded);

    for (scope, local_scope) in [
        (machine(), LOCATION),
        (session_scope(&fixture.root), BACKEND),
    ] {
        invalid(
            request(
                environment.clone(),
                scope,
                query(local_scope, None),
                Some(&peer),
            )
            .await,
        );
    }
    for (scope, local_scope) in [
        (machine(), BACKEND),
        (session_scope(&fixture.root), LOCATION),
    ] {
        for location in [
            v5::ProviderUsageForecastRequestQueryLocation::default(),
            v5::ProviderUsageForecastRequestQueryLocation {
                directory: Some(text(&fixture.directory)),
                workspace: None,
            },
        ] {
            let error = invalid(
                request(
                    environment.clone(),
                    scope.clone(),
                    query(local_scope, Some(location)),
                    Some(&peer),
                )
                .await,
            );
            assert_eq!(error.kind.as_ref().map(units).as_deref(), Some("forbidden"));
        }
    }
    let missing = invalid(
        request(
            environment.clone(),
            session_scope("ses_forecast_missing"),
            query(LOCATION, None),
            Some(&peer),
        )
        .await,
    );
    assert_eq!(
        missing.kind.as_ref().map(units).as_deref(),
        Some("not_found")
    );
    for (scope, local_scope) in [
        (machine(), BACKEND),
        (session_scope(&fixture.root), LOCATION),
    ] {
        let expired = request(
            environment.clone(),
            scope,
            query(local_scope, None),
            Some(&expired_peer()),
        )
        .await;
        assert_eq!(expired.type_name, v5::UnauthorizedError::full_name());
        decode_strict::<v5::UnauthorizedError>(&expired.payload).unwrap();
    }
    seeded.quota.shutdown().await.unwrap();
    fixture.close().await;
}
