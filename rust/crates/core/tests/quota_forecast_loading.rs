use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use ycoding_core::resources::{
    config::{Configuration, LoadOptions, Roots},
    credential,
    model::quota::{Endpoints, Service},
};
use ycoding_schema::{
    DomainEncode, JsonObject, JsonValue, LosslessString, provider, schema::NonNegativeInt,
    usage_forecast,
};
use ycoding_store::{Metadata, Options, Store, import, resources};

const MINUTE: i64 = 60_000;
const ORIGIN: i64 = 1_800_000_000_000;

struct Provider {
    endpoint: String,
    calls: Arc<AtomicUsize>,
    hold: Arc<AtomicBool>,
    fail: Arc<AtomicBool>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    server: tokio::task::JoinHandle<()>,
}

impl Provider {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::<AtomicUsize>::default();
        let hold = Arc::<AtomicBool>::default();
        let fail = Arc::<AtomicBool>::default();
        let entered = Arc::<Notify>::default();
        let release = Arc::<Notify>::default();
        let server = {
            let calls = calls.clone();
            let hold = hold.clone();
            let fail = fail.clone();
            let entered = entered.clone();
            let release = release.clone();
            tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = vec![0; 4096];
                    let size = socket.read(&mut bytes).await.unwrap();
                    let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
                    calls.fetch_add(1, Ordering::SeqCst);
                    let (status, body) = if request.starts_with("GET /key ") {
                        if hold.swap(false, Ordering::SeqCst) {
                            entered.notify_one();
                            release.notified().await;
                        }
                        if fail.load(Ordering::SeqCst) {
                            (500, "{}")
                        } else {
                            (200, r#"{"data":{"limit":10,"limit_remaining":9}}"#)
                        }
                    } else {
                        (403, "{}")
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
            calls,
            hold,
            fail,
            entered,
            release,
            server,
        }
    }

    async fn shutdown(self) {
        self.server.abort();
        assert!(self.server.await.unwrap_err().is_cancelled());
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

struct Harness {
    _store: Store,
    credentials: credential::Service,
    usage: Service,
    provider: Provider,
    openrouter: provider::Id,
}

impl Harness {
    async fn start() -> Self {
        let store = Store::disposable(
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([32; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        credentials
            .create(
                "forecast-key".into(),
                "openrouter".into(),
                None,
                secret("synthetic-forecast-key"),
                0,
            )
            .await
            .unwrap();
        let provider = Provider::start().await;
        let usage = Service::new(
            credentials.clone(),
            Endpoints(BTreeMap::from([(
                "openrouter".into(),
                provider.endpoint.clone(),
            )])),
        )
        .unwrap();
        Self {
            _store: store,
            credentials,
            usage,
            provider,
            openrouter: provider::Id("openrouter".into()),
        }
    }

    async fn shutdown(self) {
        self.usage.shutdown().await.unwrap();
        self.provider.shutdown().await;
    }

    async fn refresh(&self, at: i64) -> ycoding_schema::provider_usage::Snapshot {
        self.usage
            .get(self.openrouter.clone(), None, true, ORIGIN + at)
            .await
    }

    async fn forecast(&self, at: i64) -> usage_forecast::Info {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.usage.forecast(
                std::slice::from_ref(&self.openrouter),
                None,
                NonNegativeInt::new(ORIGIN + at).unwrap(),
            ),
        )
        .await
        .expect("forecast waited for a provider usage load")
    }
}

fn secret(key: &str) -> resources::Secret {
    resources::Secret::new(
        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: key.into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

fn quotas(forecast: &usage_forecast::Info) -> &[usage_forecast::Quota] {
    forecast.quotas.as_deref().unwrap()
}

#[tokio::test]
async fn a_cold_forecast_makes_no_provider_request() {
    let harness = Harness::start().await;
    let forecast = harness.forecast(0).await;
    assert!(quotas(&forecast).is_empty());
    assert_eq!(harness.provider.calls(), 0);
    harness.shutdown().await;
}

#[tokio::test]
async fn an_expired_cache_forecasts_from_the_last_snapshot_without_a_new_request() {
    let harness = Harness::start().await;
    harness.refresh(0).await;
    assert_eq!(harness.provider.calls(), 2);
    let forecast = harness.forecast(10 * MINUTE).await;
    let quota = &quotas(&forecast)[0];
    assert_eq!(quota.window_id, "key".into());
    assert_eq!(quota.updated_at.get(), ORIGIN);
    assert_eq!(harness.provider.calls(), 2);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_warm_forecast_does_not_wait_for_a_held_refresh() {
    let harness = Harness::start().await;
    harness.refresh(0).await;
    harness.provider.hold.store(true, Ordering::SeqCst);
    let refreshing = {
        let usage = harness.usage.clone();
        let openrouter = harness.openrouter.clone();
        tokio::spawn(async move {
            usage
                .get(openrouter, None, true, ORIGIN + 10 * MINUTE)
                .await
        })
    };
    harness.provider.entered.notified().await;
    assert_eq!(harness.provider.calls(), 3);
    let forecast = harness.forecast(10 * MINUTE).await;
    let quota = &quotas(&forecast)[0];
    assert_eq!(quota.window_id, "key".into());
    assert_eq!(quota.updated_at.get(), ORIGIN);
    assert_eq!(harness.provider.calls(), 3);
    harness.provider.release.notify_one();
    let refreshed = refreshing.await.unwrap();
    assert_eq!(refreshed.updated_at.get(), ORIGIN + 10 * MINUTE);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_cold_forecast_does_not_join_a_held_refresh() {
    let harness = Harness::start().await;
    harness.provider.hold.store(true, Ordering::SeqCst);
    let refreshing = {
        let usage = harness.usage.clone();
        let openrouter = harness.openrouter.clone();
        tokio::spawn(async move { usage.get(openrouter, None, true, ORIGIN).await })
    };
    harness.provider.entered.notified().await;
    let forecast = harness.forecast(0).await;
    assert!(quotas(&forecast).is_empty());
    assert_eq!(harness.provider.calls(), 1);
    harness.provider.release.notify_one();
    assert_eq!(refreshing.await.unwrap().status, "available".into());
    harness.shutdown().await;
}

#[tokio::test]
async fn a_rotated_or_replaced_credential_omits_the_previous_cached_quota() {
    let harness = Harness::start().await;
    harness.refresh(0).await;
    assert_eq!(harness.provider.calls(), 2);
    let previous = harness
        .credentials
        .list(&LosslessString::from("openrouter"))
        .unwrap()
        .remove(0);
    harness
        .credentials
        .update(
            previous.id().clone(),
            None,
            Some(secret("synthetic-rotated-key")),
            ORIGIN + MINUTE,
        )
        .await
        .unwrap();
    assert!(quotas(&harness.forecast(2 * MINUTE).await).is_empty());
    harness
        .credentials
        .remove(previous.id().clone(), ORIGIN + 3 * MINUTE)
        .await
        .unwrap();
    harness
        .credentials
        .create(
            "replacement-key".into(),
            "openrouter".into(),
            None,
            secret("synthetic-replacement-key"),
            ORIGIN + 3 * MINUTE,
        )
        .await
        .unwrap();
    assert!(quotas(&harness.forecast(4 * MINUTE).await).is_empty());
    assert_eq!(harness.provider.calls(), 2);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_forecast_does_not_retry_a_failed_initial_load() {
    let harness = Harness::start().await;
    harness.provider.fail.store(true, Ordering::SeqCst);
    assert_eq!(harness.refresh(0).await.status, "error".into());
    assert_eq!(harness.provider.calls(), 1);
    assert!(quotas(&harness.forecast(MINUTE).await).is_empty());
    assert_eq!(harness.provider.calls(), 1);
    harness.shutdown().await;
}

#[tokio::test]
async fn a_forecast_reads_the_app_server_cache_without_starting_the_process() {
    let root = std::env::temp_dir().join(format!(
        "ycoding-quota-forecast-loading-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let marker = root.join("spawns");
    let script = format!(
        r#"require('fs').appendFileSync({},'x');let b='';for await(const c of Bun.stdin.stream()){{b+=new TextDecoder().decode(c);while(b.includes('\n')){{let n=b.indexOf('\n');let q=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(q.id!==undefined)console.log(JSON.stringify({{id:q.id,result:q.method==='initialize'?{{}}:{{primary:{{usedPercent:5}}}}}}));}}}}"#,
        serde_json::to_string(marker.to_str().unwrap()).unwrap()
    );
    let mut command = JsonObject::new();
    command.insert("command".into(), "bun".encode());
    command.insert(
        "args".into(),
        JsonValue::Array(vec!["-e".encode(), script.encode()]),
    );
    let mut usage = JsonObject::new();
    usage.insert("codex_app_server".into(), command.encode());
    let mut document = JsonObject::new();
    document.insert("provider_usage".into(), usage.encode());
    let config = Configuration::load(LoadOptions {
        directory: root.clone(),
        roots: Roots::development(&root).unwrap(),
        project: false,
        file: None,
        content: Some(ycoding_schema::stringify_json(&document.encode())),
        env: BTreeMap::new(),
    })
    .unwrap();
    let store = Store::disposable(
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([33; 16], 1),
    )
    .unwrap();
    let service = Service::new(
        credential::Service::new(store.client()),
        Endpoints::default(),
    )
    .unwrap()
    .with_configuration(&config)
    .unwrap();
    let openai = [provider::Id("openai".into())];
    let forecast =
        |at: i64| service.forecast(&openai, None, NonNegativeInt::new(ORIGIN + at).unwrap());
    assert_eq!(forecast(0).await.quotas.unwrap().len(), 0);
    assert!(!marker.exists());
    service.list(&openai, false, ORIGIN).await;
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    let later = forecast(10 * MINUTE).await.quotas.unwrap();
    assert_eq!(later.len(), 1);
    assert_eq!(later[0].reason, Some("Quota account is unbound".into()));
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "x");
    service.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
