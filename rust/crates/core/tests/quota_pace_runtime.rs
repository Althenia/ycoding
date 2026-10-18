use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::{
    event_feed::{Data, Ephemeral, Feed, Payload, Scope, Subscriber},
    resources::{
        credential,
        model::{
            account_identity,
            quota::{Endpoints, Service},
        },
    },
};
use ycoding_schema::{
    DomainEncode, LosslessString, provider,
    provider_usage::{self, QuotaPaceAlert},
    schema::NonNegativeInt,
    stringify_json, usage_forecast,
};
use ycoding_store::{Metadata, Options, Store, import, resources};

const MINUTE: i64 = 60_000;
const ORIGIN: i64 = 1_800_000_000_000;
const HALF_CYCLE: i64 = 5_000_000;

struct Cursor {
    endpoint: String,
    used: Arc<AtomicU32>,
    fail: Arc<AtomicBool>,
    server: tokio::task::JoinHandle<()>,
}

impl Cursor {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let used = Arc::<AtomicU32>::default();
        let fail = Arc::<AtomicBool>::default();
        let server = {
            let used = used.clone();
            let fail = fail.clone();
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = vec![0; 4096];
                    let size = socket.read(&mut bytes).await.unwrap();
                    let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
                    let (status, body) = if !request.starts_with("POST /GetCurrentPeriodUsage ") {
                        (403, "{}".to_owned())
                    } else if fail.load(Ordering::SeqCst) {
                        (500, "{}".to_owned())
                    } else {
                        (
                            200,
                            format!(
                                r#"{{"billingCycleStart":"{}","billingCycleEnd":"{}","planUsage":{{"totalPercentUsed":{}}}}}"#,
                                ORIGIN - HALF_CYCLE,
                                ORIGIN + HALF_CYCLE,
                                used.load(Ordering::SeqCst)
                            ),
                        )
                    };
                    socket
                        .write_all(
                            format!(
                                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                }
            })
        };
        Self {
            endpoint,
            used,
            fail,
            server,
        }
    }

    async fn shutdown(self) {
        self.server.abort();
        assert!(self.server.await.unwrap_err().is_cancelled());
    }
}

struct Harness {
    _store: Store,
    credentials: credential::Service,
    usage: Service,
    cursor: Cursor,
    feed: Feed,
    events: Subscriber,
    provider: provider::Id,
}

impl Harness {
    async fn start() -> Self {
        let store = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([34; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        credentials
            .create(
                "pace-label".into(),
                "cursor".into(),
                None,
                resources::Secret::new(
                    ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                        key: "synthetic-cursor-token".into(),
                        metadata: None,
                    })
                    .encode(),
                )
                .unwrap(),
                0,
            )
            .await
            .unwrap();
        let cursor = Cursor::start().await;
        let usage = Service::new(
            credentials.clone(),
            Endpoints(BTreeMap::from([("cursor".into(), cursor.endpoint.clone())])),
        )
        .unwrap();
        let feed = Feed::attach(&store.client());
        let events = feed
            .subscribe_types(Scope::Global, &["provider.quota.pace"], || {})
            .unwrap();
        Self {
            _store: store,
            credentials,
            usage,
            cursor,
            feed,
            events,
            provider: provider::Id("cursor".into()),
        }
    }

    fn fed(&self) -> Service {
        self.usage.clone().with_events(self.feed.clone())
    }

    async fn refresh(&self, usage: &Service, used: u32, at: i64) -> provider_usage::Snapshot {
        self.cursor.used.store(used, Ordering::SeqCst);
        usage
            .get(self.provider.clone(), None, true, ORIGIN + at)
            .await
    }

    async fn forecast(&self, at: i64) -> usage_forecast::Info {
        self.usage
            .forecast(
                std::slice::from_ref(&self.provider),
                None,
                NonNegativeInt::new(ORIGIN + at).unwrap(),
            )
            .await
    }

    fn published(&self) -> Vec<Ephemeral> {
        std::iter::from_fn(|| self.events.next().unwrap())
            .map(|item| match &item.payload {
                Payload::Ephemeral(event) => event.clone(),
                Payload::Durable(_) => panic!("durable event on the pace subscription"),
            })
            .collect()
    }

    async fn shutdown(self) {
        self.usage.shutdown().await.unwrap();
        self.cursor.shutdown().await;
    }
}

fn pace_of(forecast: &usage_forecast::Info, window: &str) -> Option<usage_forecast::Pace> {
    forecast
        .quotas
        .as_ref()
        .unwrap()
        .iter()
        .find(|quota| quota.window_id == window.into())
        .unwrap_or_else(|| panic!("quota {window}"))
        .pace
        .clone()
}

fn alert(milestone: &str, title: &str, body: &str) -> Data {
    Data::ProviderQuotaPace(Box::new(QuotaPaceAlert {
        provider_id: provider::Id("cursor".into()),
        window_id: "included".into(),
        milestone: provider_usage::PaceMilestone(milestone.into()),
        reset_at: NonNegativeInt::new(ORIGIN + HALF_CYCLE).unwrap(),
        title: title.into(),
        body: body.into(),
    }))
}

fn cutting() -> Data {
    alert(
        "cutting-it-close",
        "Cutting it close",
        "Projected quota use exceeds 90% of its limit at reset.",
    )
}

fn running_out() -> Data {
    alert(
        "will-run-out",
        "Will run out",
        "Quota use is at its limit or projected to exceed it before reset.",
    )
}

fn window(
    id: &str,
    used: f64,
    reset_at: Option<i64>,
    period: Option<i64>,
) -> provider_usage::Window {
    provider_usage::Window {
        id: id.into(),
        label: id.into(),
        unit: "percent".into(),
        used: Some(used),
        limit: None,
        remaining: None,
        unlimited: None,
        reset_at: reset_at.map(|value| NonNegativeInt::new(value).unwrap()),
        period_seconds: period.map(|value| NonNegativeInt::new(value).unwrap()),
    }
}

fn header_observation(at: i64, used: f64) -> provider_usage::Observation {
    provider_usage::Observation {
        provider_id: provider::Id("anthropic".into()),
        label: "Claude".into(),
        source: "response_headers".into(),
        stability: "observed".into(),
        observed_at: NonNegativeInt::new(ORIGIN + at).unwrap(),
        windows: vec![
            window("five-hour", used, Some(ORIGIN + 9_000_000), Some(18_000)),
            window("overage", 10.0, None, None),
        ],
    }
}

fn anthropic_service(store: &Store) -> Service {
    Service::new(
        credential::Service::new(store.client()),
        Endpoints::provider(),
    )
    .unwrap()
}

fn core_store() -> Store {
    Store::disposable(
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([35; 16], 1),
    )
    .unwrap()
}

#[tokio::test]
async fn forecast_attaches_a_whole_window_pace_to_an_unbound_account() {
    let store = core_store();
    let usage = anthropic_service(&store);
    usage.observe(header_observation(0, 60.0), None).unwrap();
    let forecast = usage
        .forecast(
            &[provider::Id("anthropic".into())],
            None,
            NonNegativeInt::new(ORIGIN).unwrap(),
        )
        .await;
    let quota = forecast
        .quotas
        .as_ref()
        .unwrap()
        .iter()
        .find(|quota| quota.window_id == "five-hour".into())
        .unwrap();
    assert_eq!(quota.reason, Some("Quota account is unbound".into()));
    let pace = quota.pace.clone().unwrap();
    assert_eq!(
        pace.verdict,
        usage_forecast::PaceVerdict("will-run-out".into())
    );
    assert_eq!(pace.projected_used_at_reset, 120.0);
    let exhaustion = pace.exhaustion_at.unwrap().get();
    assert!(
        (exhaustion - (ORIGIN + 6_000_000)).abs() <= 1,
        "{exhaustion}"
    );
    assert_eq!(pace_of(&forecast, "overage"), None);
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn pace_requires_a_current_available_snapshot() {
    let harness = Harness::start().await;
    harness.refresh(&harness.usage, 60, 0).await;
    let fresh = pace_of(&harness.forecast(0).await, "included").unwrap();
    assert_eq!(
        fresh.verdict,
        usage_forecast::PaceVerdict("will-run-out".into())
    );
    assert_eq!(fresh.projected_used_at_reset, 120.0);
    assert!(pace_of(&harness.forecast(10 * MINUTE).await, "included").is_some());
    assert_eq!(
        pace_of(&harness.forecast(10 * MINUTE + 1).await, "included"),
        None
    );
    assert_eq!(pace_of(&harness.forecast(-1).await, "included"), None);
    harness.cursor.fail.store(true, Ordering::SeqCst);
    let stale = harness.refresh(&harness.usage, 60, MINUTE).await;
    assert_eq!(stale.status, "stale".into());
    assert_eq!(
        pace_of(&harness.forecast(2 * MINUTE).await, "included"),
        None
    );
    harness.shutdown().await;
}

#[tokio::test]
async fn alerts_reach_the_feed_once_without_session_location_or_account() {
    let harness = Harness::start().await;
    let usage = harness.fed();
    harness.refresh(&usage, 40, 0).await;
    assert!(harness.published().is_empty());
    harness.refresh(&usage, 46, 1_000).await;
    let events = harness.published();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].session, None);
    assert_eq!(events[0].location, None);
    assert_eq!(events[0].data, cutting());
    let account = account_identity(
        &harness
            .credentials
            .list(&LosslessString::from("cursor"))
            .unwrap()[0],
    );
    let encoded = stringify_json(&events[0].data.encode());
    for private in [
        account.to_utf8().unwrap(),
        "pace-label".to_owned(),
        "synthetic-cursor-token".to_owned(),
    ] {
        assert!(!encoded.contains(&private), "{private}");
    }
    usage
        .get(harness.provider.clone(), None, false, ORIGIN + 1_500)
        .await;
    harness.forecast(1_500).await;
    harness.refresh(&usage, 46, 2_000).await;
    assert!(harness.published().is_empty());
    harness.refresh(&usage, 60, 3_000).await;
    let worse = harness.published();
    assert_eq!(worse.len(), 1);
    assert_eq!(worse[0].data, running_out());
    harness.shutdown().await;
}

#[tokio::test]
async fn a_pending_alert_without_a_feed_is_retried_once_a_feed_is_attached() {
    let harness = Harness::start().await;
    harness.refresh(&harness.usage, 40, 0).await;
    let unfed = harness.refresh(&harness.usage, 46, 1_000).await;
    assert_eq!(unfed.status, "available".into());
    assert!(harness.published().is_empty());
    let usage = harness.fed();
    usage
        .forecast(
            std::slice::from_ref(&harness.provider),
            None,
            NonNegativeInt::new(ORIGIN + 1_500).unwrap(),
        )
        .await;
    assert!(harness.published().is_empty());
    usage
        .get(harness.provider.clone(), None, false, ORIGIN + 1_500)
        .await;
    let events = harness.published();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].data, cutting());
    usage
        .get(harness.provider.clone(), None, false, ORIGIN + 1_600)
        .await;
    assert!(harness.published().is_empty());
    harness.shutdown().await;
}

#[tokio::test]
async fn observed_windows_alert_only_for_a_bound_account() {
    let store = core_store();
    let feed = Feed::attach(&store.client());
    let events = feed
        .subscribe_types(Scope::Global, &["provider.quota.pace"], || {})
        .unwrap();
    let usage = anthropic_service(&store).with_events(feed.clone());
    let account = LosslessString::from("synthetic-account");
    usage
        .observe(header_observation(0, 40.0), Some(account.clone()))
        .unwrap();
    usage
        .observe(header_observation(1_000, 99.0), None)
        .unwrap();
    assert!(events.next().unwrap().is_none());
    usage
        .observe(header_observation(2_000, 46.0), Some(account))
        .unwrap();
    let item = events.next().unwrap().unwrap();
    let Payload::Ephemeral(event) = &item.payload else {
        panic!("ephemeral event")
    };
    let Data::ProviderQuotaPace(alert) = &event.data else {
        panic!("quota pace event")
    };
    assert_eq!(alert.provider_id, provider::Id("anthropic".into()));
    assert_eq!(alert.window_id, "five-hour".into());
    assert_eq!(
        alert.milestone,
        provider_usage::PaceMilestone("cutting-it-close".into())
    );
    assert_eq!(alert.reset_at.get(), ORIGIN + 9_000_000);
    assert!(events.next().unwrap().is_none());
    usage.shutdown().await.unwrap();
}
