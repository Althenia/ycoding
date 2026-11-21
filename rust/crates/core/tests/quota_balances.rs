use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::resources::{
    auth::{Client, claude},
    credential,
    model::{
        account_identity,
        quota::{Endpoints, Service},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, parse_json, provider, provider_usage, schema::NonNegativeInt,
};
use ycoding_store::{Metadata, Options, Store, resources};

type Handler = Arc<dyn Fn(&str) -> (u16, String) + Send + Sync>;

struct Server {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn server(handler: Handler) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = requests.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let handler = handler.clone();
            let captured = captured.clone();
            tokio::spawn(async move {
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                loop {
                    let count = socket.read(&mut chunk).await.unwrap_or(0);
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let request = String::from_utf8_lossy(&bytes).into_owned();
                captured.lock().unwrap().push(request.clone());
                let (status, body) = handler(&request);
                let _ = socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            });
        }
    });
    Server {
        endpoint,
        requests,
        task,
    }
}

fn path(request: &str) -> &str {
    request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("")
}

fn store(seed: u8) -> Store {
    Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([seed; 16], 1),
    )
    .unwrap()
}

async fn openai_service(seed: u8, secret_json: &str, handler: Handler) -> (Store, Server, Service) {
    let store = store(seed);
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "openai-key".into(),
            "openai".into(),
            None,
            resources::Secret::new(
                ycoding_schema::credential::Value::decode(&parse_json(secret_json).unwrap())
                    .unwrap()
                    .encode(),
            )
            .unwrap(),
            0,
        )
        .await
        .unwrap();
    let server = server(handler).await;
    let service = Service::new(
        credentials,
        Endpoints(BTreeMap::from([("openai".into(), server.endpoint.clone())])),
    )
    .unwrap();
    (store, server, service)
}

#[tokio::test]
async fn openai_non_admin_key_reports_api_credit_balance_only() {
    let (store, server, service) = openai_service(
        21,
        r#"{"type":"key","key":"fixture-key"}"#,
        Arc::new(|request| {
            assert_eq!(path(request), "/dashboard/billing/credit_grants");
            (
                200,
                r#"{"total_granted":100,"total_used":25,"total_available":75}"#.into(),
            )
        }),
    )
    .await;
    let snapshot = service
        .get(provider::Id("openai".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.source, "provider_internal_api".into());
    assert_eq!(snapshot.stability, "best_effort".into());
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].id, "api-credit-balance".into());
    assert_eq!(snapshot.windows[0].unit, "usd".into());
    assert_eq!(snapshot.windows[0].remaining, Some(75.0));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn openai_non_admin_balance_failure_is_not_reported_as_zero() {
    let (store, _server, service) = openai_service(
        22,
        r#"{"type":"key","key":"fixture-key"}"#,
        Arc::new(|_| (403, "{}".into())),
    )
    .await;
    let snapshot = service
        .get(provider::Id("openai".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.status, "unauthorized".into());
    assert!(snapshot.windows.is_empty());
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn openai_admin_organization_failure_falls_back_to_balance_with_message() {
    let (store, _server, service) = openai_service(
        23,
        r#"{"type":"key","key":"fixture-key","metadata":{"usageAdmin":true}}"#,
        Arc::new(|request| {
            if path(request) == "/dashboard/billing/credit_grants" {
                (200, r#"{"total_available":5}"#.into())
            } else {
                (403, "{}".into())
            }
        }),
    )
    .await;
    let snapshot = service
        .get(provider::Id("openai".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.source, "provider_internal_api".into());
    assert_eq!(snapshot.stability, "best_effort".into());
    assert_eq!(
        snapshot.message,
        Some("Organization usage unavailable".into())
    );
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].id, "api-credit-balance".into());
    assert_eq!(snapshot.windows[0].remaining, Some(5.0));
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn openai_admin_success_appends_balance_and_balance_failure_only_adds_message() {
    for (seed, balance_status, balance_body, expect_window) in [
        (24u8, 200u16, r#"{"total_available":12}"#, true),
        (25u8, 500u16, "{}", false),
    ] {
        let (store, _server, service) = openai_service(
            seed,
            r#"{"type":"key","key":"fixture-key","metadata":{"usageAdmin":true}}"#,
            Arc::new(move |request| {
                if path(request) == "/dashboard/billing/credit_grants" {
                    (balance_status, balance_body.into())
                } else {
                    (200, r#"{"data":[],"has_more":false}"#.into())
                }
            }),
        )
        .await;
        let snapshot = service
            .get(provider::Id("openai".into()), None, true, 100)
            .await;
        assert_eq!(snapshot.status, "available".into());
        let balance = snapshot
            .windows
            .iter()
            .find(|window| window.id == "api-credit-balance".into());
        if expect_window {
            assert_eq!(snapshot.source, "provider_internal_api".into());
            assert_eq!(snapshot.stability, "best_effort".into());
            assert_eq!(balance.and_then(|window| window.remaining), Some(12.0));
            assert_eq!(snapshot.windows.len(), 7);
        } else {
            assert!(balance.is_none());
            assert_eq!(
                snapshot.message,
                Some("API credit balance unavailable".into())
            );
            assert_eq!(snapshot.windows.len(), 6);
        }
        service.shutdown().await.unwrap();
        store.shutdown().unwrap();
    }
}

const SOURCE: &str = "11111111-1111-4111-8111-111111111111";
const ORG: &str = "00000000-0000-4000-8000-000000000001";
static NEXT: AtomicU64 = AtomicU64::new(0);

fn profile_root() -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "ycoding-quota-balances-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn write_profile(root: &Path, access: &str) {
    let directory = claude::profile_directory(root, SOURCE).unwrap();
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join(".credentials.json"),
        serde_json::json!({"claudeAiOauth":{"accessToken":access,"refreshToken":format!("refresh-{access}"),"expiresAt":9_007_199_254_740_990i64,"subscriptionType":"max"},"keep":true}).to_string(),
    )
    .unwrap();
}

async fn claude_service(
    seed: u8,
    root: &Path,
    handler: Handler,
) -> (Store, Server, Service, claude::Store, credential::Info) {
    let store = store(seed);
    let credentials = credential::Service::new(store.client());
    let saved = credentials
        .create(
            "claude".into(),
            "anthropic".into(),
            Some("claude".into()),
            claude::managed_secret(SOURCE).unwrap(),
            1,
        )
        .await
        .unwrap();
    let server = server(handler).await;
    let accounts = claude::Store::new(
        claude::Source::new(root.to_path_buf(), None).unwrap(),
        Client::new(&server.endpoint, "fixture").unwrap(),
    );
    let service = Service::new(
        credentials,
        Endpoints(BTreeMap::from([(
            "anthropic".into(),
            server.endpoint.clone(),
        )])),
    )
    .unwrap()
    .with_auth(Default::default(), Some(accounts.clone()));
    (store, server, service, accounts, saved)
}

fn claude_handler(profile_body: &'static str, prepaid_body: &'static str) -> Handler {
    Arc::new(move |request| {
        let path = path(request);
        if path == "/api/oauth/usage" {
            (200, r#"{"five_hour":{"utilization":23}}"#.into())
        } else if path == "/api/oauth/profile" {
            (200, profile_body.into())
        } else if path == format!("/api/oauth/organizations/{ORG}/prepaid/credits") {
            (200, prepaid_body.into())
        } else {
            (404, "{}".into())
        }
    })
}

#[tokio::test]
async fn claude_prepaid_balance_is_appended_in_dollars_for_the_same_token() {
    let root = profile_root();
    write_profile(&root, "synthetic-token");
    let (store, server, service, accounts, _saved) = claude_service(
        26,
        &root,
        claude_handler(
            r#"{"organization":{"uuid":"00000000-0000-4000-8000-000000000001"}}"#,
            r#"{"amount":1250,"currency":"USD"}"#,
        ),
    )
    .await;
    let snapshot = service
        .get(provider::Id("anthropic".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.message, None);
    assert_eq!(snapshot.windows.len(), 2);
    assert_eq!(snapshot.windows[0].id, "five-hour".into());
    assert_eq!(snapshot.windows[0].used, Some(23.0));
    assert_eq!(snapshot.windows[1].id, "prepaid-balance".into());
    assert_eq!(snapshot.windows[1].unit, "usd".into());
    assert_eq!(snapshot.windows[1].remaining, Some(12.5));
    {
        let requests = server.requests.lock().unwrap();
        let paths = requests
            .iter()
            .map(|request| path(request))
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            [
                "/api/oauth/usage",
                "/api/oauth/profile",
                "/api/oauth/organizations/00000000-0000-4000-8000-000000000001/prepaid/credits"
            ]
        );
        assert!(
            requests
                .iter()
                .all(|request| request.contains("authorization: Bearer synthetic-token"))
        );
        assert!(requests[2].contains("x-organization-uuid: 00000000-0000-4000-8000-000000000001"));
    }
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn claude_token_change_after_profile_aborts_balance_only() {
    let root = profile_root();
    write_profile(&root, "synthetic-first");
    let rotated = root.clone();
    let handler: Handler = Arc::new(move |request| {
        let path = path(request);
        if path == "/api/oauth/usage" {
            (200, r#"{"five_hour":{"utilization":10}}"#.into())
        } else if path == "/api/oauth/profile" {
            write_profile(&rotated, "synthetic-next");
            (
                200,
                r#"{"organization":{"uuid":"00000000-0000-4000-8000-000000000001"}}"#.into(),
            )
        } else {
            (200, r#"{"amount":100,"currency":"USD"}"#.into())
        }
    });
    let (store, server, service, accounts, _saved) = claude_service(27, &root, handler).await;
    let snapshot = service
        .get(provider::Id("anthropic".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].used, Some(10.0));
    assert_eq!(snapshot.message, Some("Prepaid balance unavailable".into()));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn claude_invalid_organization_uuid_reports_balance_unavailable_without_balance_request() {
    let root = profile_root();
    write_profile(&root, "synthetic-token");
    let (store, server, service, accounts, _saved) = claude_service(
        28,
        &root,
        claude_handler(
            r#"{"organization":{"uuid":"not-a-uuid"}}"#,
            r#"{"amount":100,"currency":"USD"}"#,
        ),
    )
    .await;
    let snapshot = service
        .get(provider::Id("anthropic".into()), None, true, 100)
        .await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.message, Some("Prepaid balance unavailable".into()));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}

fn header_observation() -> provider_usage::Observation {
    provider_usage::Observation {
        provider_id: provider::Id("anthropic".into()),
        label: "Claude".into(),
        source: "response_headers".into(),
        stability: "observed".into(),
        observed_at: NonNegativeInt::new(200).unwrap(),
        windows: vec![provider_usage::Window {
            group: None,
            id: "five-hour".into(),
            label: "Session".into(),
            unit: "percent".into(),
            used: Some(20.0),
            limit: None,
            remaining: None,
            unlimited: None,
            reset_at: None,
            period_seconds: None,
        }],
    }
}

#[tokio::test]
async fn anthropic_header_observation_survives_later_failed_fetch_with_its_message() {
    let root = profile_root();
    write_profile(&root, "synthetic-token");
    let (store, _server, service, accounts, saved) =
        claude_service(29, &root, Arc::new(|_| (500, "{}".into()))).await;
    service
        .observe(header_observation(), Some(account_identity(&saved)))
        .unwrap();
    let snapshot = service
        .get(provider::Id("anthropic".into()), None, false, 300)
        .await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.source, "response_headers".into());
    assert_eq!(
        snapshot.message,
        Some("Provider usage refresh failed".into())
    );
    assert_eq!(snapshot.windows.len(), 1);
    assert_eq!(snapshot.windows[0].used, Some(20.0));
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}

#[tokio::test]
async fn anthropic_header_observation_keeps_cached_prepaid_balance() {
    let root = profile_root();
    write_profile(&root, "synthetic-token");
    let (store, server, service, accounts, saved) = claude_service(
        30,
        &root,
        claude_handler(
            r#"{"organization":{"uuid":"00000000-0000-4000-8000-000000000001"}}"#,
            r#"{"amount":400,"currency":"USD"}"#,
        ),
    )
    .await;
    let first = service
        .get(provider::Id("anthropic".into()), None, true, 100)
        .await;
    assert_eq!(first.windows.len(), 2);
    service
        .observe(header_observation(), Some(account_identity(&saved)))
        .unwrap();
    let snapshot = service
        .get(provider::Id("anthropic".into()), None, false, 300)
        .await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.source, "provider_internal_api".into());
    assert_eq!(
        snapshot
            .windows
            .iter()
            .map(|window| window.id.as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        ["five-hour", "prepaid-balance"]
    );
    assert_eq!(snapshot.windows[0].used, Some(20.0));
    assert_eq!(snapshot.windows[1].remaining, Some(4.0));
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(&root).unwrap();
}
