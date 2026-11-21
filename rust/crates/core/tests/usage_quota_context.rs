use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, oneshot},
};
use ycoding_core::{
    generation_activity,
    resources::{credential, model::quota},
    session::store,
    usage_dashboard, usage_view,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, location, parse_json, provider, provider_usage,
    schema::NonNegativeInt, usage_dashboard as domain,
};
use ycoding_store::{Metadata, Options, Store, native, resources::Secret};

#[path = "report_support/prepared.rs"]
mod prepared_support;
#[path = "report_support/mod.rs"]
mod report_support;

struct Request {
    respond: oneshot::Sender<(u16, String)>,
    closed: oneshot::Receiver<()>,
}

struct Endpoint {
    url: String,
    calls: Arc<AtomicUsize>,
    active: Arc<AtomicUsize>,
    requests: mpsc::UnboundedReceiver<Request>,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

impl Endpoint {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let (send, requests) = mpsc::unbounded_channel();
        let (stop, mut stopped) = oneshot::channel();
        let observed = calls.clone();
        let connections = active.clone();
        let task = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            loop {
                let (mut socket, _) = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted.unwrap(),
                };
                let send = send.clone();
                let observed = observed.clone();
                let connections = connections.clone();
                tasks.spawn(async move {
                    let mut bytes = Vec::new();
                    while !bytes.ends_with(b"\r\n\r\n") {
                        let mut byte = [0];
                        assert_eq!(socket.read(&mut byte).await.unwrap(), 1);
                        bytes.push(byte[0]);
                        assert!(bytes.len() <= 8192);
                    }
                    assert!(bytes.starts_with(b"GET /usage HTTP/1.1\r\n"));
                    observed.fetch_add(1, Ordering::SeqCst);
                    connections.fetch_add(1, Ordering::SeqCst);
                    let (respond, response) = oneshot::channel();
                    let (closed, receiver) = oneshot::channel();
                    send.send(Request { respond, closed: receiver }).unwrap();
                    let mut eof = [0];
                    tokio::select! {
                        response = response => {
                            let (status, body) = response.unwrap();
                            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                        }
                        read = socket.read(&mut eof) => assert_eq!(read.unwrap(), 0),
                    }
                    connections.fetch_sub(1, Ordering::SeqCst);
                    let _ = closed.send(());
                });
            }
            while let Some(result) = tasks.join_next().await {
                result.unwrap();
            }
        });
        Self {
            url,
            calls,
            active,
            requests,
            stop,
            task,
        }
    }

    async fn next(&mut self) -> Request {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn close(self) {
        self.stop.send(()).unwrap();
        self.task.await.unwrap();
    }
}

struct Fixture {
    _reports: report_support::Reports,
    store: Store,
    credentials: credential::Service,
    quota: quota::Service,
    views: usage_view::Service,
    dashboard: usage_dashboard::Service,
    endpoint: Endpoint,
}

fn location() -> location::Ref {
    location::Ref::decode(&parse_json(r#"{"directory":"/synthetic"}"#).unwrap()).unwrap()
}

fn secret(value: &str) -> Secret {
    Secret::new(parse_json(&format!(r#"{{"type":"key","key":"{value}"}}"#)).unwrap()).unwrap()
}

fn response(used: u32) -> String {
    format!(
        r#"{{"usage":{{"rolling":{{"percent":{used}}},"weekly":{{"percent":0}},"monthly":{{"percent":0}}}}}}"#
    )
}

impl Fixture {
    async fn new() -> Self {
        let store = Store::disposable(
            Options::core(),
            native::catalog(native::DatabaseKind::Core),
            Metadata::new([12; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        credentials
            .create(
                "cred_one".into(),
                "opencode-go".into(),
                Some("First".into()),
                secret("synthetic-one"),
                0,
            )
            .await
            .unwrap();
        let endpoint = Endpoint::new().await;
        let quota = quota::Service::new(
            credentials.clone(),
            quota::Endpoints(BTreeMap::from([(
                "opencode-go".into(),
                endpoint.url.clone(),
            )])),
        )
        .unwrap()
        .with_store(store.client());
        let reports = report_support::start(store.client());
        let views = usage_view::Service::new(store::Service::new(store.client()), None);
        prepared_support::publish(&store.client(), &views);
        let dashboard = usage_dashboard::Service::new(
            views.clone(),
            generation_activity::Service::new(0, 0),
            Arc::new(|| (0, 0)),
        );
        Self {
            _reports: reports,
            store,
            credentials,
            quota,
            views,
            dashboard,
            endpoint,
        }
    }

    fn load(
        &self,
        id: &str,
        refresh: bool,
        now: i64,
    ) -> tokio::task::JoinHandle<provider_usage::Snapshot> {
        let quota = self.quota.clone();
        let id = id.into();
        tokio::spawn(async move {
            quota
                .get(provider::Id("opencode-go".into()), Some(&id), refresh, now)
                .await
        })
    }

    async fn publish(&self, generation: u64, now: i64) {
        prepared_support::publish(&self.store.client(), &self.views);
        assert!(
            self.quota
                .publish(
                    &self.views,
                    &location(),
                    generation,
                    &[provider::Id("opencode-go".into())],
                    NonNegativeInt::new(now).unwrap()
                )
                .await
                .unwrap()
        );
    }

    async fn close(self) {
        self.dashboard.shutdown().await.unwrap();
        self.quota.shutdown().await.unwrap();
        self.endpoint.close().await;
    }
}

#[tokio::test]
async fn dashboard_read_does_not_retain_a_provider_execution_capability() {
    let fixture = Fixture::new().await;
    let cached = domain::Input::decode(&parse_json("{}").unwrap()).unwrap();
    assert!(matches!(
        fixture.dashboard.read(domain::Quota::Preparing, &cached),
        domain::Info::Ready(_)
    ));
    let input = domain::Input::decode(&parse_json(r#"{"refresh":true}"#).unwrap()).unwrap();
    assert!(matches!(
        fixture.dashboard.read(domain::Quota::Preparing, &input),
        domain::Info::Ready(ready) if matches!(ready.quota, domain::Quota::Preparing)
    ));
    assert!(fixture.quota.prepared(&location(), 7).unwrap().is_none());
    assert_eq!(fixture.endpoint.calls.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.endpoint.active.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn identity_and_configuration_changes_do_not_alias_publications_or_late_completions() {
    let mut fixture = Fixture::new().await;
    fixture
        .credentials
        .create(
            "cred_two".into(),
            "opencode-go".into(),
            Some("Second".into()),
            secret("synthetic-two"),
            0,
        )
        .await
        .unwrap();
    let old = fixture.load("cred_one", false, 0);
    let first = fixture.endpoint.next().await;
    fixture
        .credentials
        .update(
            "cred_one".into(),
            None,
            Some(secret("synthetic-replaced")),
            1,
        )
        .await
        .unwrap();
    let current = fixture.load("cred_one", false, 1);
    let second = fixture.endpoint.next().await;
    let other = fixture.load("cred_two", false, 1);
    let third = fixture.endpoint.next().await;
    second.respond.send((200, response(20))).unwrap();
    third.respond.send((200, response(30))).unwrap();
    assert_eq!(current.await.unwrap().windows[0].used, Some(20.0));
    assert_eq!(other.await.unwrap().windows[0].used, Some(30.0));
    first.respond.send((200, response(10))).unwrap();
    let stale = old.await.unwrap();
    assert_eq!(stale.status, "unsupported".into());
    assert_eq!(
        stale.message,
        Some("Provider usage account changed during refresh".into())
    );
    assert!(stale.windows.is_empty());
    fixture.publish(7, 2).await;
    let published = fixture.quota.prepared(&location(), 7).unwrap().unwrap();
    assert_eq!(
        published
            .providers
            .iter()
            .map(|value| (
                value.profile.as_ref().unwrap().to_utf8().unwrap(),
                value.windows[0].used
            ))
            .collect::<Vec<_>>(),
        vec![
            ("First".to_owned(), Some(20.0)),
            ("Second".to_owned(), Some(30.0))
        ]
    );
    assert!(fixture.quota.prepared(&location(), 8).unwrap().is_none());
    fixture.views.invalidate();
    assert!(fixture.quota.prepared(&location(), 7).unwrap().is_none());
    fixture.publish(8, 3).await;
    assert!(fixture.quota.prepared(&location(), 7).unwrap().is_none());
    assert!(fixture.quota.prepared(&location(), 8).unwrap().is_some());
    fixture
        .credentials
        .update("cred_one".into(), Some("Renamed".into()), None, 4)
        .await
        .unwrap();
    assert!(fixture.quota.prepared(&location(), 8).unwrap().is_none());
    assert_eq!(fixture.endpoint.calls.load(Ordering::SeqCst), 3);
    fixture.close().await;
}

#[tokio::test]
async fn quota_ttl_refresh_and_pending_dedup_preserve_reported_zero_false_and_absence() {
    let mut fixture = Fixture::new().await;
    let started = Instant::now();
    let first = fixture.load("cred_one", false, 0);
    let request = fixture.endpoint.next().await;
    let id = "cred_one".into();
    let mut joined = Box::pin(fixture.quota.get(
        provider::Id("opencode-go".into()),
        Some(&id),
        true,
        0,
    ));
    tokio::select! { biased; _ = &mut joined => panic!("refresh must join the pending load"), _ = std::future::ready(()) => {} }
    request.respond.send((200, response(0))).unwrap();
    let initial = first.await.unwrap();
    assert_eq!(joined.await, initial);
    assert_eq!(initial.windows[0].used, Some(0.0));
    assert_eq!(initial.windows[0].remaining, None);
    assert_eq!(initial.windows[0].limit, None);
    assert_eq!(
        fixture.load("cred_one", false, 59_999).await.unwrap(),
        initial
    );
    assert_eq!(fixture.endpoint.calls.load(Ordering::SeqCst), 1);
    let expired = 60_000 + started.elapsed().as_millis() as i64 + 1;
    let next = fixture.load("cred_one", false, expired);
    fixture
        .endpoint
        .next()
        .await
        .respond
        .send((200, response(0)))
        .unwrap();
    assert_eq!(next.await.unwrap().windows[0].used, Some(0.0));
    assert_eq!(fixture.endpoint.calls.load(Ordering::SeqCst), 2);
    let refresh = fixture.load("cred_one", true, expired);
    let request = fixture.endpoint.next().await;
    let id = "cred_one".into();
    let mut joined = Box::pin(fixture.quota.get(
        provider::Id("opencode-go".into()),
        Some(&id),
        true,
        expired,
    ));
    tokio::select! { biased; _ = &mut joined => panic!("refresh must join the pending load"), _ = std::future::ready(()) => {} }
    request.respond.send((200, response(0))).unwrap();
    assert_eq!(refresh.await.unwrap(), joined.await);
    assert_eq!(fixture.endpoint.calls.load(Ordering::SeqCst), 3);
    let account = ycoding_core::resources::model::account_identity(
        &fixture
            .credentials
            .get(&"cred_one".into())
            .unwrap()
            .unwrap(),
    );
    fixture.quota.observe(provider_usage::Observation::decode(&parse_json(&format!(r#"{{"providerID":"opencode-go","label":"Synthetic","source":"response_stream","stability":"observed","observedAt":{},"windows":[{{"id":"tokens","label":"Tokens","unit":"tokens","used":0,"remaining":0,"unlimited":false,"resetAt":0}}]}}"#, expired + 1)).unwrap()).unwrap(), Some(account)).unwrap();
    fixture.publish(7, expired + 1).await;
    let published = fixture.quota.prepared(&location(), 7).unwrap().unwrap();
    let window = &published.providers[0].windows[0];
    assert_eq!(
        (window.used, window.remaining, window.unlimited),
        (Some(0.0), Some(0.0), Some(false))
    );
    assert_eq!(window.limit, None);
    assert_eq!(window.reset_at.unwrap().get(), 0);
    fixture.close().await;
}

#[tokio::test]
async fn malformed_or_failed_quota_producers_return_only_the_generic_failure() {
    let mut fixture = Fixture::new().await;
    for (now, status, body) in [
        (0, 200, "{}"),
        (1, 503, r#"{"token":"synthetic-internal-diagnostic"}"#),
    ] {
        fixture.quota.request_refresh(&location(), 7).unwrap();
        let quota = fixture.quota.clone();
        let views = fixture.views.clone();
        let pending = tokio::spawn(async move {
            quota
                .publish(
                    &views,
                    &location(),
                    7,
                    &[provider::Id("opencode-go".into())],
                    NonNegativeInt::new(now).unwrap(),
                )
                .await
        });
        let request = fixture.endpoint.next().await;
        request.respond.send((status, body.to_owned())).unwrap();
        assert!(pending.await.unwrap().unwrap());
        let prepared = fixture.quota.prepared(&location(), 7).unwrap().unwrap();
        let snapshot = &prepared.providers[0];
        assert_eq!(snapshot.status, "error".into());
        assert_eq!(
            snapshot.message,
            Some("Provider usage refresh failed".into())
        );
        assert!(snapshot.windows.is_empty());
        assert!(!format!("{:?}", snapshot.encode()).contains("synthetic-internal-diagnostic"));
        assert_eq!(fixture.endpoint.active.load(Ordering::SeqCst), 0);
    }
    fixture.close().await;
}

#[tokio::test]
async fn shutdown_cancels_and_joins_active_work_and_releases_all_connections() {
    let mut fixture = Fixture::new().await;
    fixture
        .credentials
        .create(
            "cred_two".into(),
            "opencode-go".into(),
            Some("Second".into()),
            secret("synthetic-two"),
            0,
        )
        .await
        .unwrap();
    let first = fixture.load("cred_one", false, 0);
    let first_connection = fixture.endpoint.next().await;
    let second = fixture.load("cred_two", false, 0);
    let second_connection = fixture.endpoint.next().await;
    assert_eq!(fixture.endpoint.active.load(Ordering::SeqCst), 2);
    fixture.quota.shutdown().await.unwrap();
    let Request {
        respond: _first_response,
        closed: first_closed,
    } = first_connection;
    let Request {
        respond: _second_response,
        closed: second_closed,
    } = second_connection;
    tokio::time::timeout(Duration::from_secs(5), first_closed)
        .await
        .unwrap()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), second_closed)
        .await
        .unwrap()
        .unwrap();
    for pending in [first, second] {
        let snapshot = pending.await.unwrap();
        assert_eq!(snapshot.status, "error".into());
        assert_eq!(
            snapshot.message,
            Some("Provider usage publication failed".into())
        );
        assert!(snapshot.windows.is_empty());
    }
    assert_eq!(fixture.endpoint.active.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.endpoint.calls.load(Ordering::SeqCst), 2);
    assert!(fixture.quota.prepared(&location(), 7).is_err());
    fixture.dashboard.shutdown().await.unwrap();
    assert!(matches!(
        fixture.dashboard.read(
            domain::Quota::Preparing,
            &domain::Input::decode(&parse_json("{}").unwrap()).unwrap()
        ),
        domain::Info::Error { .. }
    ));
    fixture.endpoint.close().await;
}
