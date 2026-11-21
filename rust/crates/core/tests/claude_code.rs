use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_ai::{
    auth::Secret,
    cache::{Hint, Policy},
    claude_code::{self, Account, Credentials, Resolution, Settings},
    llm::{Message, Request, ToolDefinition},
    route::Executor,
};
use ycoding_core::resources::{
    auth::{Client, claude},
    catalog::models_dev,
    credential,
    model::{self, ClaudeHost, quota},
};
use ycoding_schema::{DomainDecode, DomainEncode, parse_json, provider, stringify_json};

#[path = "session_support/mod.rs"]
mod support;

const A: &str = "11111111-1111-4111-8111-111111111111";
const B: &str = "22222222-2222-4222-8222-222222222222";
const FRESH: i64 = 9_007_199_254_740_990;
const SUCCESS: &str = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\ndata: {\"type\":\"message_stop\"}\n\n";
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Profiles(PathBuf);
impl Profiles {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ycoding-claude-route-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, source: &str, access: &str, expiry: i64) {
        let directory = claude::profile_directory(&self.0, source).unwrap();
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(".credentials.json"), serde_json::json!({"claudeAiOauth":{"accessToken":access,"refreshToken":format!("refresh-{access}"),"expiresAt":expiry,"subscriptionType":"max"},"keep":true}).to_string()).unwrap();
    }
    fn store(&self, endpoint: &str) -> claude::Store {
        claude::Store::new(
            claude::Source::new(self.0.clone(), None).unwrap(),
            Client::new(endpoint, "fixture").unwrap(),
        )
    }
}
impl Drop for Profiles {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn info(package: &str, base: &str) -> ycoding_schema::model::Info {
    let mut model = models_dev::normalize(
        &parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap()[0]
        .models[0]
        .clone();
    model.package = Some(package.into());
    model.provider_id = provider::Id("anthropic".into());
    model.model_id = "claude-opus-5".into();
    model.settings = Some(ycoding_schema::provider::Settings::decode(&parse_json(&serde_json::json!({"apiKey":"claude-code","claudeCodeSource":B,"baseURL":format!("{base}/v1")}).to_string()).unwrap()).unwrap());
    model
}
async fn selected(service: &credential::Service, source: &str, label: &str) -> credential::Info {
    service
        .create(
            label.into(),
            "anthropic".into(),
            Some(label.into()),
            claude::managed_secret(source).unwrap(),
            1,
        )
        .await
        .unwrap()
}
fn host(
    store: &ycoding_store::Store,
    accounts: claude::Store,
    credentials: credential::Service,
) -> ClaudeHost {
    ClaudeHost {
        accounts,
        quota: quota::Service::new(credentials.clone(), quota::Endpoints(BTreeMap::new())).unwrap(),
        credentials,
        sessions: ycoding_core::session::store::Service::new(store.client()),
        settings: ycoding_ai::claude_code::Settings {
            version: "2.1.289".into(),
            entrypoint: "sdk-cli".into(),
            user_agent: "claude-cli/2.1.289 (external, sdk-cli)".into(),
            beta_flags: String::new(),
            debug_file: None,
        },
    }
}
fn request(
    info: &ycoding_schema::model::Info,
    selected: &credential::Info,
    host: &ClaudeHost,
) -> Request {
    let value = selected.secret().domain().unwrap();
    let model =
        model::from_catalog_model_with_claude(info, Some(&value), Some(selected), Some(host))
            .unwrap();
    let mut request = Request::new(model);
    request.cache = Policy::None;
    request.messages = vec![Message::user("visible user")];
    request
        .http
        .headers
        .insert("x-ycoding-session".into(), "ses_one".into());
    request
        .http
        .headers
        .insert("x-session-id".into(), "session-affinity".into());
    request
}

struct Fixture {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl Fixture {
    async fn new(responses: Vec<(u16, &'static str, &'static str)>) -> Self {
        Self::with_headers(responses.into_iter().map(|(status,usage,body)| (status,format!("Content-Type: text/event-stream\r\nanthropic-ratelimit-unified-5h-utilization: {usage}\r\n"),body)).collect()).await
    }
    async fn with_headers(responses: Vec<(u16, String, &'static str)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let task = tokio::spawn(async move {
            for (status, headers, body) in responses {
                let (mut socket, _) =
                    tokio::time::timeout(Duration::from_secs(10), listener.accept())
                        .await
                        .unwrap()
                        .unwrap();
                let request = read_request(&mut socket).await;
                captured.lock().unwrap().push(request);
                socket.write_all(format!("HTTP/1.1 {status} Fixture\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            endpoint,
            requests,
            task: Some(task),
        }
    }
    async fn finish(&mut self) {
        self.task.take().unwrap().await.unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 4096];
            let count = socket.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(end) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                let length = String::from_utf8_lossy(&bytes[..end])
                    .lines()
                    .find_map(|line| {
                        line.to_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    return String::from_utf8(bytes).unwrap();
                }
            }
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn cold_quota_uses_selected_claude_source_preserves_zero_and_omits_absent_private_values() {
    let profiles = Profiles::new();
    profiles.write(A, "private-selected", FRESH);
    profiles.write(B, "private-active", FRESH);
    let mut fixture=Fixture::with_headers(vec![(200,"Content-Type: application/json\r\n".into(),r#"{"five_hour":{"utilization":0},"seven_day":null,"extra_usage":{"is_enabled":true,"monthly_limit":1000},"email":"private-email","accessToken":"private-payload"}"#)]).await;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let first = selected(&credentials, A, "selected").await;
    selected(&credentials, B, "active").await;
    let accounts = profiles.store(&fixture.endpoint);
    let service = quota::Service::new(
        credentials.clone(),
        quota::Endpoints(BTreeMap::from([(
            "anthropic".into(),
            fixture.endpoint.clone(),
        )])),
    )
    .unwrap()
    .with_auth(Default::default(), Some(accounts.clone()));
    let result = service
        .get(
            provider::Id("anthropic".into()),
            Some(first.id()),
            false,
            100,
        )
        .await;
    assert_eq!(result.status, "available".into());
    assert_eq!(result.source, "provider_internal_api".into());
    assert_eq!(result.stability, "best_effort".into());
    assert_eq!(result.label, "Claude Max".into());
    assert_eq!(result.profile, Some("selected".into()));
    assert_eq!(result.windows.len(), 2);
    assert_eq!(result.windows[0].used, Some(0.0));
    assert_eq!(result.windows[1].used, None);
    assert_eq!(result.windows[1].remaining, None);
    assert_eq!(result.windows[1].limit, Some(10.0));
    let public = stringify_json(&result.encode());
    for private in [
        A,
        B,
        "private-selected",
        "private-active",
        "private-email",
        "private-payload",
    ] {
        assert!(!public.contains(private), "{private}");
    }
    fixture.finish().await;
    {
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /api/oauth/usage "));
        assert!(requests[0].contains("authorization: Bearer private-selected"));
        assert!(requests[0].contains("anthropic-beta: oauth-2025-04-20"));
    }
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn rejected_quota_resets_reuse_cached_oauth_for_get_list_and_prepared_forecast() {
    const NOW: i64 = 1_800_000_000_000;
    const OAUTH: &str = r#"{"five_hour":{"utilization":5,"resets_at":1800003600000},"seven_day":{"utilization":5,"resets_at":1800003600000}}"#;
    for cached_before in [true, false] {
        for read in ["get", "list", "forecast"] {
            let profiles = Profiles::new();
            profiles.write(A, "synthetic-reset-access", FRESH);
            let mut fixture = Fixture::with_headers(vec![(
                200,
                "Content-Type: application/json\r\n".into(),
                OAUTH,
            )])
            .await;
            let store = support::store();
            let credentials = credential::Service::new(store.client());
            let limited = selected(&credentials, A, "Limited").await;
            let accounts = profiles.store(&fixture.endpoint);
            let usage = quota::Service::new(
                credentials.clone(),
                quota::Endpoints(BTreeMap::from([(
                    "anthropic".into(),
                    fixture.endpoint.clone(),
                )])),
            )
            .unwrap()
            .with_auth(Default::default(), Some(accounts.clone()));
            let provider = provider::Id("anthropic".into());
            if cached_before {
                let cached = usage.get(provider.clone(), None, false, NOW).await;
                assert_eq!(cached.windows[0].used, Some(5.0));
                assert_eq!(cached.profile, Some("Limited".into()));
            }
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                "anthropic-ratelimit-unified-7d-status",
                reqwest::header::HeaderValue::from_static("rejected"),
            );
            headers.insert(
                "anthropic-ratelimit-unified-7d-reset",
                reqwest::header::HeaderValue::from_static("1800000003"),
            );
            headers.insert(
                "anthropic-ratelimit-unified-5h-utilization",
                reqwest::header::HeaderValue::from_static("0.1"),
            );
            headers.insert(
                "anthropic-ratelimit-unified-5h-reset",
                reqwest::header::HeaderValue::from_static("1800000003"),
            );
            usage
                .observe(
                    claude_code::normalize_headers(&headers, None, NOW + 1000, Some(429)).unwrap(),
                    Some(model::account_identity(&limited)),
                )
                .unwrap();
            if !cached_before {
                let retained = usage.get(provider.clone(), None, true, NOW + 2000).await;
                assert_eq!(
                    retained
                        .windows
                        .iter()
                        .find(|window| window.id == "seven-day".into())
                        .unwrap()
                        .used,
                    Some(100.0)
                );
                assert_eq!(
                    retained
                        .windows
                        .iter()
                        .find(|window| window.id == "five-hour".into())
                        .unwrap()
                        .used,
                    Some(5.0)
                );
            }
            let cached_at = if cached_before { NOW } else { NOW + 2000 };
            let views = ycoding_core::usage_view::Service::new(
                ycoding_core::session::store::Service::new(store.client()),
                None,
            );
            let location = ycoding_schema::location::Ref::decode(
                &parse_json(r#"{"directory":"/synthetic/quota-reset"}"#).unwrap(),
            )
            .unwrap();
            for (at, exhausted) in [(NOW + 2000, true), (NOW + 3000, false)] {
                if read == "forecast" {
                    assert!(
                        usage
                            .publish(
                                &views,
                                &location,
                                0,
                                std::slice::from_ref(&provider),
                                ycoding_schema::schema::NonNegativeInt::new(at).unwrap()
                            )
                            .await
                            .unwrap()
                    );
                    let publication = usage.prepared(&location, 0).unwrap().unwrap();
                    let quota = publication
                        .backend
                        .quotas
                        .as_ref()
                        .unwrap()
                        .iter()
                        .find(|quota| quota.window_id == "seven-day".into())
                        .unwrap();
                    assert_eq!(
                        quota.profile,
                        Some(ycoding_schema::model::ProfileName("Limited".into()))
                    );
                    assert_eq!(
                        publication.providers[0]
                            .windows
                            .iter()
                            .find(|window| window.id == "five-hour".into())
                            .unwrap()
                            .used,
                        Some(if exhausted && cached_before {
                            10.0
                        } else {
                            5.0
                        })
                    );
                    if exhausted {
                        assert_eq!(quota.state.0, "exhausted".into());
                    } else {
                        assert_ne!(quota.state.0, "exhausted".into());
                        assert_ne!(quota.reason, Some("Quota window has expired".into()));
                        assert_eq!(quota.source.0, "provider_internal_api".into());
                        assert_eq!(quota.updated_at.get(), cached_at);
                        assert_eq!(publication.providers[0].windows[0].used, Some(5.0));
                    }
                    assert_eq!(publication.primary.get(&provider), Some(&0));
                } else {
                    let snapshot = if read == "get" {
                        usage.get(provider.clone(), None, false, at).await
                    } else {
                        usage
                            .list(std::slice::from_ref(&provider), false, at)
                            .await
                            .remove(0)
                    };
                    assert_eq!(
                        snapshot
                            .windows
                            .iter()
                            .find(|window| window.id == "seven-day".into())
                            .unwrap()
                            .used,
                        Some(if exhausted { 100.0 } else { 5.0 })
                    );
                    assert_eq!(
                        snapshot
                            .windows
                            .iter()
                            .find(|window| window.id == "five-hour".into())
                            .unwrap()
                            .used,
                        Some(if exhausted && cached_before {
                            10.0
                        } else {
                            5.0
                        })
                    );
                    assert_eq!(snapshot.profile, Some("Limited".into()));
                    if !exhausted {
                        assert_eq!(snapshot.source, "provider_internal_api".into());
                        assert_eq!(snapshot.updated_at.get(), cached_at);
                    }
                }
            }
            fixture.finish().await;
            assert_eq!(fixture.requests.lock().unwrap().len(), 1);
            usage.shutdown().await.unwrap();
            accounts.shutdown().await.unwrap();
            credentials.shutdown().await.unwrap();
            store.shutdown().unwrap();
        }
    }
}

#[tokio::test]
async fn quota_warnings_follow_the_bound_profile_and_only_expired_response_windows_disappear() {
    use ycoding_core::event_feed::{Data, Feed, Payload, Scope};

    const NOW: i64 = 1_800_000_000_000;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let limited = selected(&credentials, A, "Limited").await;
    let source = model::account_identity(&limited);
    let feed = Feed::attach(&store.client());
    let events = feed
        .subscribe_types(Scope::Global, &["provider.quota.pace"], || {})
        .unwrap();
    let usage = quota::Service::new(credentials.clone(), quota::Endpoints::default())
        .unwrap()
        .with_events(feed);
    let provider = provider::Id("anthropic".into());
    let observe = |at, entries: &[(&'static str, &'static str)], status| {
        let mut headers = reqwest::header::HeaderMap::new();
        for (name, value) in entries {
            headers.insert(*name, reqwest::header::HeaderValue::from_static(value));
        }
        claude_code::normalize_headers(&headers, None, at, status).unwrap()
    };
    usage
        .observe(
            observe(
                NOW,
                &[
                    ("anthropic-ratelimit-unified-7d-utilization", "0.05"),
                    ("anthropic-ratelimit-unified-7d-reset", "1800000003"),
                    ("anthropic-ratelimit-unified-7d-sonnet-utilization", "0.05"),
                    ("anthropic-ratelimit-unified-7d-sonnet-reset", "1800003600"),
                ],
                None,
            ),
            Some(source.clone()),
        )
        .unwrap();
    assert_eq!(
        usage
            .get(provider.clone(), Some(limited.id()), false, NOW)
            .await
            .profile,
        Some("Limited".into())
    );
    let healthy = selected(&credentials, B, "Healthy").await;
    usage
        .observe(
            observe(
                NOW,
                &[
                    ("anthropic-ratelimit-unified-7d-utilization", "0.05"),
                    ("anthropic-ratelimit-unified-7d-reset", "1800003600"),
                ],
                None,
            ),
            Some(model::account_identity(&healthy)),
        )
        .unwrap();
    usage
        .observe(
            observe(
                NOW + 1000,
                &[
                    ("anthropic-ratelimit-unified-7d-status", "rejected"),
                    ("anthropic-ratelimit-unified-7d-reset", "1800000003"),
                    ("anthropic-ratelimit-unified-7d-sonnet-status", "rejected"),
                    ("anthropic-ratelimit-unified-7d-sonnet-reset", "1800003600"),
                ],
                Some(429),
            ),
            Some(source.clone()),
        )
        .unwrap();
    usage.flush_alerts().await;
    let mut delivered = 0;
    while let Some(item) = events.next().unwrap() {
        let Payload::Ephemeral(event) = &item.payload else {
            panic!("ephemeral quota event")
        };
        let Data::ProviderQuotaPace(alert) = &event.data else {
            panic!("quota pace event")
        };
        let body = alert.body.as_str().unwrap();
        assert!(body.contains("Claude · Limited · "));
        assert!(!body.contains("Healthy"));
        assert!(!stringify_json(&alert.encode()).contains(source.as_str().unwrap()));
        delivered += 1;
    }
    assert_eq!(delivered, 4);
    let active = usage.get(provider.clone(), None, false, NOW + 1000).await;
    assert_eq!(active.profile, Some("Healthy".into()));
    assert_eq!(active.windows[0].used, Some(5.0));
    usage
        .observe(
            observe(
                NOW + 1500,
                &[("anthropic-ratelimit-unified-5h-utilization", "0.1")],
                None,
            ),
            Some(source.clone()),
        )
        .unwrap();
    let retained = usage
        .get(provider.clone(), Some(limited.id()), false, NOW + 1500)
        .await;
    assert_eq!(
        retained
            .windows
            .iter()
            .find(|window| window.id == "seven-day".into())
            .unwrap()
            .used,
        Some(100.0)
    );
    usage
        .observe(
            observe(
                NOW + 2000,
                &[
                    ("anthropic-ratelimit-unified-7d-utilization", "0.15"),
                    ("anthropic-ratelimit-unified-7d-reset", "1800000003"),
                ],
                None,
            ),
            Some(source.clone()),
        )
        .unwrap();
    usage
        .observe(
            observe(
                NOW + 1900,
                &[("anthropic-ratelimit-unified-7d-utilization", "0")],
                None,
            ),
            Some(source),
        )
        .unwrap();
    let allowed = usage
        .get(provider.clone(), Some(limited.id()), false, NOW + 2000)
        .await;
    assert_eq!(allowed.windows[0].used, Some(15.0));
    usage
        .observe(
            observe(
                NOW + 1000,
                &[
                    ("anthropic-ratelimit-unified-status", "rejected"),
                    ("anthropic-ratelimit-unified-reset", "1800000003"),
                ],
                Some(429),
            ),
            None,
        )
        .unwrap();
    assert!(
        usage
            .list(std::slice::from_ref(&provider), false, NOW + 2000)
            .await
            .iter()
            .any(|snapshot| snapshot.profile.is_none())
    );
    assert!(
        usage
            .list(std::slice::from_ref(&provider), false, NOW + 3000)
            .await
            .iter()
            .all(|snapshot| snapshot.profile.is_some())
    );
    let remaining = usage
        .get(provider.clone(), Some(limited.id()), false, NOW + 3000)
        .await;
    assert!(
        remaining
            .windows
            .iter()
            .all(|window| window.id != "seven-day".into())
    );
    assert_eq!(remaining.windows[0].id, "seven-day-sonnet".into());
    assert_eq!(remaining.windows[0].used, Some(100.0));
    let views = ycoding_core::usage_view::Service::new(
        ycoding_core::session::store::Service::new(store.client()),
        None,
    );
    let location = ycoding_schema::location::Ref::decode(
        &parse_json(r#"{"directory":"/synthetic/quota-profiles"}"#).unwrap(),
    )
    .unwrap();
    assert!(
        usage
            .publish(
                &views,
                &location,
                0,
                std::slice::from_ref(&provider),
                ycoding_schema::schema::NonNegativeInt::new(NOW + 3000).unwrap()
            )
            .await
            .unwrap()
    );
    let publication = usage.prepared(&location, 0).unwrap().unwrap();
    assert!(
        publication
            .backend
            .quotas
            .as_ref()
            .unwrap()
            .iter()
            .all(|quota| quota.window_id != "unified".into())
    );
    assert!(
        publication
            .backend
            .quotas
            .as_ref()
            .unwrap()
            .iter()
            .any(|quota| quota.profile
                == Some(ycoding_schema::model::ProfileName("Limited".into()))
                && quota.window_id == "seven-day-sonnet".into()
                && quota.state.0 == "exhausted".into())
    );
    credentials
        .update(
            limited.id().clone(),
            Some("a-limited@example.invalid".into()),
            None,
            NOW + 4000,
        )
        .await
        .unwrap();
    credentials
        .update(
            healthy.id().clone(),
            Some("z-healthy@example.invalid".into()),
            None,
            NOW + 4000,
        )
        .await
        .unwrap();
    assert_eq!(
        usage
            .get(provider.clone(), Some(limited.id()), false, NOW + 4000)
            .await
            .profile,
        None
    );
    assert!(
        usage
            .publish(
                &views,
                &location,
                0,
                std::slice::from_ref(&provider),
                ycoding_schema::schema::NonNegativeInt::new(NOW + 4000).unwrap()
            )
            .await
            .unwrap()
    );
    let publication = usage.prepared(&location, 0).unwrap().unwrap();
    assert!(
        publication
            .providers
            .iter()
            .all(|snapshot| snapshot.profile.is_none())
    );
    let active = &publication.providers[*publication.primary.get(&provider).unwrap()];
    assert_eq!(active.windows[0].id, "seven-day".into());
    assert_eq!(active.windows[0].used, Some(5.0));
    let expired = usage
        .get(provider, Some(limited.id()), false, NOW + 3_600_000)
        .await;
    assert!(expired.windows.is_empty());
    usage.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn cold_claude_quota_retries_401_once_after_selected_source_refresh() {
    let profiles = Profiles::new();
    profiles.write(A, "expired-selected", FRESH);
    profiles.write(B, "active-untouched", FRESH);
    let mut fixture=Fixture::with_headers(vec![(401,"".into(),"private rejected token"),(200,"Content-Type: application/json\r\n".into(),r#"{"access_token":"rotated-selected","refresh_token":"rotated-refresh","expires_in":3600}"#),(200,"Content-Type: application/json\r\n".into(),r#"{"five_hour":{"utilization":42}}"#)]).await;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let first = selected(&credentials, A, "selected").await;
    selected(&credentials, B, "active").await;
    let accounts = profiles.store(&fixture.endpoint);
    let service = quota::Service::new(
        credentials.clone(),
        quota::Endpoints(BTreeMap::from([(
            "anthropic".into(),
            fixture.endpoint.clone(),
        )])),
    )
    .unwrap()
    .with_auth(Default::default(), Some(accounts.clone()));
    let result = service
        .get(
            provider::Id("anthropic".into()),
            Some(first.id()),
            true,
            100,
        )
        .await;
    assert_eq!(result.status, "available".into());
    assert_eq!(result.windows[0].used, Some(42.0));
    fixture.finish().await;
    {
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].contains("authorization: Bearer expired-selected"));
        assert!(requests[1].starts_with("POST /v1/oauth/token "));
        assert!(requests[1].contains("refresh-expired-selected"));
        assert!(requests[2].contains("authorization: Bearer rotated-selected"));
        assert!(
            !requests
                .iter()
                .any(|request| request.contains("active-untouched"))
        );
    }
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn claude_quota_retry_after_preserves_stale_zero_and_blocks_forced_refresh_until_expiry() {
    let profiles = Profiles::new();
    profiles.write(A, "private-selected", FRESH);
    let mut fixture = Fixture::with_headers(vec![
        (200, "".into(), r#"{"five_hour":{"utilization":0}}"#),
        (200, "".into(), r#"{"organization":{}}"#),
        (429, "Retry-After: 60\r\n".into(), "private-secret-upstream"),
        (200, "".into(), r#"{"five_hour":{"utilization":42}}"#),
        (200, "".into(), r#"{"organization":{}}"#),
    ])
    .await;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let first = selected(&credentials, A, "selected").await;
    let accounts = profiles.store(&fixture.endpoint);
    let service = quota::Service::new(
        credentials.clone(),
        quota::Endpoints(BTreeMap::from([(
            "anthropic".into(),
            fixture.endpoint.clone(),
        )])),
    )
    .unwrap()
    .with_auth(Default::default(), Some(accounts.clone()));
    let provider = provider::Id("anthropic".into());
    assert_eq!(
        service
            .get(provider.clone(), Some(first.id()), false, 100)
            .await
            .status,
        "available".into()
    );
    let stale = service
        .get(provider.clone(), Some(first.id()), true, 200)
        .await;
    assert_eq!(stale.status, "stale".into());
    assert_eq!(stale.windows[0].used, Some(0.0));
    assert_eq!(stale.message, Some("Provider usage refresh failed".into()));
    assert!(!stringify_json(&stale.encode()).contains("private-secret"));
    let held = service
        .get(provider.clone(), Some(first.id()), true, 1000)
        .await;
    assert_eq!(held.status, "stale".into());
    assert_eq!(held.windows[0].used, Some(0.0));
    assert_eq!(fixture.requests.lock().unwrap().len(), 3);
    assert_eq!(
        service
            .get(provider, Some(first.id()), true, 100_000)
            .await
            .windows[0]
            .used,
        Some(42.0)
    );
    fixture.finish().await;
    service.shutdown().await.unwrap();
    accounts.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn cold_claude_quota_retry_headers_distinguish_fractional_zero_invalid_and_absent_delay() {
    for (header, holds) in [
        ("Retry-After: 1.5\r\n", true),
        ("Retry-After: 0\r\n", false),
        ("Retry-After: -1\r\n", false),
        ("Retry-After: invalid\r\n", false),
        ("", false),
    ] {
        let profiles = Profiles::new();
        profiles.write(A, "private-selected", FRESH);
        let mut fixture = Fixture::with_headers(vec![
            (429, header.into(), "private-upstream-secret"),
            (
                200,
                "".into(),
                r#"{"five_hour":{"utilization":0},"seven_day":null}"#,
            ),
        ])
        .await;
        let store = support::store();
        let credentials = credential::Service::new(store.client());
        let selected = selected(&credentials, A, "selected").await;
        let accounts = profiles.store(&fixture.endpoint);
        let service = quota::Service::new(
            credentials.clone(),
            quota::Endpoints(BTreeMap::from([(
                "anthropic".into(),
                fixture.endpoint.clone(),
            )])),
        )
        .unwrap()
        .with_auth(Default::default(), Some(accounts.clone()));
        let provider = provider::Id("anthropic".into());
        let failed = service
            .get(provider.clone(), Some(selected.id()), true, 100)
            .await;
        assert_eq!(failed.status, "error".into());
        assert!(failed.windows.is_empty());
        assert!(!stringify_json(&failed.encode()).contains("private-upstream"));
        assert_eq!(failed.source, "provider_internal_api".into());
        assert_eq!(failed.stability, "best_effort".into());
        if holds {
            let held = service
                .get(provider.clone(), Some(selected.id()), true, 1000)
                .await;
            assert_eq!(held.status, "error".into());
            assert!(held.windows.is_empty());
            assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        }
        let next = service.get(provider, Some(selected.id()), true, 4000).await;
        assert_eq!(next.status, "available".into());
        assert_eq!(next.windows.len(), 1);
        assert_eq!(next.windows[0].used, Some(0.0));
        fixture.finish().await;
        service.shutdown().await.unwrap();
        accounts.shutdown().await.unwrap();
        credentials.shutdown().await.unwrap();
        store.shutdown().unwrap();
    }
}

#[test]
fn sentinel_and_managed_credentials_require_a_host_and_never_lower_as_uuid_authentication() {
    for package in [
        "aisdk:@ai-sdk/anthropic",
        "@ycoding-ai/ai/providers/anthropic",
    ] {
        let info = info(package, "http://127.0.0.1:1");
        let value = claude::managed_secret(A).unwrap().domain().unwrap();
        assert!(matches!(
            model::from_catalog_model(&info, Some(&value)),
            Err(model::Error::ProfileUnavailable)
        ));
        assert!(matches!(
            model::from_catalog_model_with_claude(&info, Some(&value), None, None),
            Err(model::Error::ProfileUnavailable)
        ));
        assert!(matches!(
            model::from_catalog_model(&info, None),
            Err(model::Error::ProfileUnavailable)
        ));
        let key = ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: "fixture-api-key".into(),
            metadata: None,
        });
        let model = model::from_catalog_model(&info, Some(&key)).unwrap();
        let prepared = model.route.prepare(&Request::new(model.clone())).unwrap();
        assert_eq!(prepared.headers["x-api-key"], "fixture-api-key");
        assert!(!stringify_json(&prepared.wire_body).contains("claudeCodeSource"));
        if package.starts_with("aisdk:") {
            assert!(
                prepared.headers["anthropic-beta"]
                    .to_str()
                    .unwrap()
                    .contains("fine-grained-tool-streaming-2025-05-14")
            );
        }
    }
}

#[test]
fn source_validation_rejects_unmanaged_reconnect_mismatch_and_expiry_records() {
    let original = claude::managed_secret(A).unwrap().domain().unwrap();
    assert_eq!(claude::credential_source(&original), Some(A));
    for changes in [
        serde_json::json!({"metadata":{"managed":false}}),
        serde_json::json!({"metadata":{"requiresLogin":true}}),
        serde_json::json!({"metadata":{"source":B}}),
        serde_json::json!({"expires":0}),
        serde_json::json!({"access":"invalid"}),
    ] {
        let mut encoded: serde_json::Value = serde_json::from_str(&stringify_json(
            &ycoding_schema::DomainEncode::encode(&original),
        ))
        .unwrap();
        for (key, value) in changes.as_object().unwrap() {
            if key == "metadata" {
                for (key, value) in value.as_object().unwrap() {
                    encoded["metadata"][key] = value.clone();
                }
            } else {
                encoded[key] = value.clone();
            }
        }
        let value =
            ycoding_schema::credential::Value::decode(&parse_json(&encoded.to_string()).unwrap())
                .unwrap();
        assert!(claude::credential_source(&value).is_none());
    }
}

#[tokio::test]
async fn integrated_route_refreshes_only_selected_source_and_isolates_account_observations() {
    let profiles = Profiles::new();
    profiles.write(A, "fixture-stale-a", FRESH);
    profiles.write(B, "fixture-b", FRESH);
    let mut fixture = Fixture::new(vec![
        (401, "0.99", "{\"error\":{\"message\":\"expired\"}}"),
        (200, "0", "{\"access_token\":\"fixture-fresh-a\",\"refresh_token\":\"fixture-new-refresh\",\"expires_in\":3600}"),
        (200, "0.25", SUCCESS),
        (200, "0.75", SUCCESS),
    ]).await;
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let a = selected(&credentials, A, "Personal").await;
    let b = selected(&credentials, B, "Work").await;
    let host = host(
        &store,
        profiles.store(&fixture.endpoint),
        credentials.clone(),
    );
    let info = info("aisdk:@ai-sdk/anthropic", &fixture.endpoint);
    let executor = Executor::new(Executor::http_client().unwrap());
    assert_eq!(
        executor
            .generate(&request(&info, &a, &host))
            .await
            .unwrap()
            .text(),
        "ok".into()
    );
    assert_eq!(
        executor
            .generate(&request(&info, &b, &host))
            .await
            .unwrap()
            .text(),
        "ok".into()
    );
    fixture.finish().await;
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].starts_with("POST /v1/messages?beta=true "));
    assert!(requests[0].contains("authorization: Bearer fixture-stale-a"));
    assert!(requests[1].starts_with("POST /v1/oauth/token "));
    assert!(requests[1].contains("refresh_token=refresh-fixture-stale-a"));
    assert!(!requests[1].contains("refresh-fixture-b"));
    assert!(requests[2].contains("authorization: Bearer fixture-fresh-a"));
    assert!(requests[3].contains("authorization: Bearer fixture-b"));
    assert_eq!(
        requests[0].split_once("\r\n\r\n").unwrap().1,
        requests[2].split_once("\r\n\r\n").unwrap().1
    );
    let active = host
        .quota
        .get(provider::Id("anthropic".into()), None, false, 1)
        .await;
    assert_eq!(active.profile, Some("Work".into()));
    assert_eq!(active.windows[0].used, Some(75.0));
    let personal = host
        .quota
        .get(provider::Id("anthropic".into()), Some(a.id()), false, 1)
        .await;
    assert_eq!(personal.windows[0].used, Some(25.0));
    assert_eq!(personal.source, "response_headers".into());
    assert_eq!(
        credentials.get(a.id()).unwrap().unwrap().secret(),
        a.secret()
    );
    let current = claude::Source::new(profiles.0.clone(), None).unwrap();
    assert_eq!(
        current.read(A).await.unwrap().unwrap().refresh_token,
        "fixture-new-refresh"
    );
    assert_eq!(
        current.read(B).await.unwrap().unwrap().access_token,
        "fixture-b"
    );
    host.accounts.shutdown().await.unwrap();
    host.quota.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn expiry_refresh_happens_before_messages_and_missing_source_never_borrows_another_profile() {
    let profiles = Profiles::new();
    profiles.write(B, "fixture-b", FRESH);
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let a = selected(&credentials, A, "Personal").await;
    let mut fixture = Fixture::new(vec![
        (
            200,
            "0",
            "{\"access_token\":\"fixture-fresh-a\",\"expires_in\":3600}",
        ),
        (200, "0.5", SUCCESS),
    ])
    .await;
    let host = host(
        &store,
        profiles.store(&fixture.endpoint),
        credentials.clone(),
    );
    let info = info("@ycoding-ai/ai/providers/anthropic", &fixture.endpoint);
    let executor = Executor::new(Executor::http_client().unwrap());
    let error = executor
        .generate(&request(&info, &a, &host))
        .await
        .unwrap_err();
    assert_eq!(error.message, ycoding_ai::claude_code::RECONNECT);
    assert!(fixture.requests.lock().unwrap().is_empty());
    profiles.write(A, "fixture-expired-a", 0);
    executor.generate(&request(&info, &a, &host)).await.unwrap();
    fixture.finish().await;
    assert!(fixture.requests.lock().unwrap()[0].starts_with("POST /v1/oauth/token "));
    assert!(fixture.requests.lock().unwrap()[1].contains("authorization: Bearer fixture-fresh-a"));
    host.accounts.shutdown().await.unwrap();
    host.quota.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn route_account_generation_fence_rejects_replacement_before_dispatch_or_observation_reuse() {
    let profiles = Profiles::new();
    profiles.write(A, "fixture-a", FRESH);
    profiles.write(B, "fixture-b", FRESH);
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    let a = selected(&credentials, A, "Personal").await;
    let mut fixture = Fixture::new(vec![(200, "0.25", SUCCESS)]).await;
    let host = host(
        &store,
        profiles.store(&fixture.endpoint),
        credentials.clone(),
    );
    let info = info("aisdk:@ai-sdk/anthropic", &fixture.endpoint);
    let old_request = request(&info, &a, &host);
    let executor = Executor::new(Executor::http_client().unwrap());
    executor.generate(&old_request).await.unwrap();
    fixture.finish().await;
    credentials
        .create(
            "ignored".into(),
            "anthropic".into(),
            Some("Personal".into()),
            claude::managed_secret(B).unwrap(),
            2,
        )
        .await
        .unwrap();
    let error = executor.generate(&old_request).await.unwrap_err();
    assert_eq!(error.message, ycoding_ai::claude_code::RECONNECT);
    assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    assert!(matches!(
        model::from_catalog_model_with_claude(
            &info,
            Some(&a.secret().domain().unwrap()),
            Some(&a),
            Some(&host)
        ),
        Err(model::Error::ProfileUnavailable)
    ));
    assert!(
        host.quota
            .get(provider::Id("anthropic".into()), Some(a.id()), false, 1)
            .await
            .windows
            .is_empty()
    );
    host.accounts.shutdown().await.unwrap();
    host.quota.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn account_replacement_during_refresh_blocks_dispatch_and_during_response_blocks_quota_publication()
 {
    for refresh in [true, false] {
        let profiles = Profiles::new();
        profiles.write(A, "fixture-a", if refresh { 0 } else { FRESH });
        profiles.write(B, "fixture-b", FRESH);
        let store = support::store();
        let credentials = credential::Service::new(store.client());
        let selected = selected(&credentials, A, "Personal").await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let replacing = credentials.clone();
        let task = tokio::spawn(async move {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(10), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let sent = read_request(&mut socket).await;
            assert!(sent.starts_with(if refresh {
                "POST /v1/oauth/token "
            } else {
                "POST /v1/messages?beta=true "
            }));
            replacing
                .create(
                    "ignored".into(),
                    "anthropic".into(),
                    Some("Personal".into()),
                    claude::managed_secret(B).unwrap(),
                    2,
                )
                .await
                .unwrap();
            let body = if refresh {
                "{\"access_token\":\"fixture-new-a\",\"expires_in\":3600}"
            } else {
                SUCCESS
            };
            socket.write_all(format!("HTTP/1.1 200 Fixture\r\nContent-Length: {}\r\nanthropic-ratelimit-unified-5h-utilization: 0.99\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        });
        let host = host(&store, profiles.store(&endpoint), credentials.clone());
        let info = info("aisdk:@ai-sdk/anthropic", &endpoint);
        let result = Executor::new(Executor::http_client().unwrap())
            .generate(&request(&info, &selected, &host))
            .await;
        if refresh {
            assert_eq!(
                result.unwrap_err().message,
                ycoding_ai::claude_code::RECONNECT
            );
        } else {
            assert_eq!(result.unwrap().text(), "ok".into());
        }
        task.await.unwrap();
        assert!(
            host.quota
                .get(
                    provider::Id("anthropic".into()),
                    Some(selected.id()),
                    false,
                    1
                )
                .await
                .windows
                .is_empty()
        );
        host.accounts.shutdown().await.unwrap();
        host.quota.shutdown().await.unwrap();
        credentials.shutdown().await.unwrap();
        store.shutdown().unwrap();
    }
}

#[tokio::test]
async fn durable_billing_reader_keeps_first_user_before_completed_compaction_and_route_recreation()
{
    let store = support::store();
    store.submit(|tx| {
        use ycoding_store::session::{Message, MessageTable};
        MessageTable::insert(tx, &Message { id: "msg_original".into(), session_id: "ses_one".into(), type_: "user".into(), seq: 1, time_created: 1, time_updated: 1, data: parse_json(r#"{"text":"original durable user text","time":{"created":1}}"#).unwrap() })?;
        MessageTable::insert(tx, &Message { id: "msg_checkpoint".into(), session_id: "ses_one".into(), type_: "compaction".into(), seq: 3, time_created: 3, time_updated: 3, data: parse_json(r#"{"status":"completed","reason":"manual","summary":"checkpoint","recent":"","time":{"created":3}}"#).unwrap() })?;
        MessageTable::insert(tx, &Message { id: "msg_visible".into(), session_id: "ses_one".into(), type_: "user".into(), seq: 5, time_created: 5, time_updated: 5, data: parse_json(r#"{"text":"visible user","time":{"created":5}}"#).unwrap() })
    }).unwrap().await.unwrap();
    let profiles = Profiles::new();
    profiles.write(A, "fixture-a", FRESH);
    let credentials = credential::Service::new(store.client());
    let a = selected(&credentials, A, "Personal").await;
    let host = host(
        &store,
        profiles.store("http://127.0.0.1:1"),
        credentials.clone(),
    );
    let info = info("aisdk:@ai-sdk/anthropic", "http://127.0.0.1:1");
    let before = request(&info, &a, &host);
    let mut after = request(&info, &a, &host);
    after.messages = vec![Message::user(
        "<conversation-checkpoint>compacted</conversation-checkpoint>",
    )];
    let before = before.model.route.prepare(&before).unwrap();
    let after = after.model.route.prepare(&after).unwrap();
    assert_eq!(before.route, "anthropic-messages");
    let before: serde_json::Value = serde_json::from_str(&before.encoded_body).unwrap();
    let after: serde_json::Value = serde_json::from_str(&after.encoded_body).unwrap();
    assert_eq!(before["system"], after["system"]);
    assert_eq!(
        before["system"][0]["text"],
        "x-anthropic-billing-header: cc_version=2.1.289.ab8; cc_entrypoint=sdk-cli;"
    );
    assert_eq!(
        host.sessions
            .context(&ycoding_schema::session::Id::new("ses_one").unwrap())
            .unwrap()
            .len(),
        2
    );
    host.accounts.shutdown().await.unwrap();
    host.quota.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[path = "session_support/guardrails.rs"]
mod guardrails;

fn runner(
    store: &ycoding_store::Store,
    integration: &str,
    endpoint: &str,
    preparation: Option<ycoding_core::resources::auth::Preparation>,
    claude: Option<ClaudeHost>,
) -> ycoding_core::session::runner::Local {
    use ycoding_core::{
        resources::{agent, attachment_store, catalog::Catalog},
        session::{
            runner::{Local, Services, WallClock},
            store::Service,
        },
        tools::registry::Registry,
    };
    let source: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
    ))
    .unwrap();
    let mut record = source["openai"].clone();
    record["id"] = integration.into();
    let source = serde_json::json!({integration:record});
    let mut catalog =
        Catalog::new(models_dev::normalize(&parse_json(&source.to_string()).unwrap()).unwrap());
    let package = if integration == "anthropic" {
        "@ycoding-ai/ai/providers/anthropic"
    } else {
        "@ycoding-ai/ai/providers/openai-compatible"
    };
    let model_id = if integration == "anthropic" {
        "claude-opus-5"
    } else {
        "fixture"
    };
    catalog.configure(&[parse_json(&serde_json::json!({"model":{"providerID":integration,"model":"gpt-reasoning"},"providers":{integration:{"package":package,"settings":{"baseURL":format!("{endpoint}/v1")},"models":{"gpt-reasoning":{"modelID":model_id}}}}}).to_string()).unwrap()]).unwrap();
    let clock: Arc<dyn ycoding_core::session::runner::Clock> = Arc::new(WallClock);
    Local::new(Services {
        generation: ycoding_core::generation_activity::Service::new(clock.now(), clock.nanos()),
        snapshots: None,
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: ycoding_core::resources::domain_state::DomainState::new(agent::Service::new(vec![
            agent::empty("build".into()),
        ])),
        credentials: credential::Service::new(store.client()),
        tools: Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &ycoding_core::resources::config::Roots::development(
                    &std::env::temp_dir().join("ycoding-claude-runner-output"),
                )
                .unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-claude-runner-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock,
        executor: Arc::new(Executor::new(Executor::http_client().unwrap())),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
        skill_resolver: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        auth: preparation,
        claude,
    })
}
async fn admit(store: &ycoding_store::Store) {
    use ycoding_core::session::{pending, store::Service};
    Service::new(store.client())
        .admit(pending::Request {
            id: ycoding_schema::session_message::Id::new("msg_input").unwrap(),
            session_id: ycoding_schema::session::Id::new("ses_one").unwrap(),
            input: ycoding_schema::session_pending::Message::decode(
                &parse_json(
                    r#"{"type":"user","data":{"text":"Answer the prompt"},"delivery":"steer"}"#,
                )
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_input").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn runner_prepares_expired_openai_and_xai_oauth_before_native_request_construction() {
    const CHAT: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
    for integration in ["openai", "xai"] {
        let store = support::store();
        let credentials = credential::Service::new(store.client());
        let value = ycoding_schema::credential::Value::OAuth(ycoding_schema::credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("browser").unwrap(),
            access: "fixture-expired".into(),
            refresh: "fixture-refresh".into(),
            expires: ycoding_schema::schema::NonNegativeInt::new(1).unwrap(),
            metadata: None,
        });
        let profile = credentials
            .create(
                "profile".into(),
                integration.into(),
                Some("Work".into()),
                ycoding_store::resources::Secret::new(ycoding_schema::DomainEncode::encode(&value))
                    .unwrap(),
                1,
            )
            .await
            .unwrap();
        let mut fixture = Fixture::new(vec![(200, "0", "{\"access_token\":\"fixture-prepared\",\"refresh_token\":\"fixture-rotated\",\"expires_in\":3600}"), (200, "0", CHAT)]).await;
        let preparation = ycoding_core::resources::auth::Preparation {
            clients: BTreeMap::from([(
                integration.into(),
                Client::new(&fixture.endpoint, "fixture").unwrap(),
            )]),
            cursor: None,
            providers: None,
        };
        admit(&store).await;
        let coordinator =
            ycoding_core::session::run_coordinator::Coordinator::new(Arc::new(runner(
                &store,
                integration,
                &fixture.endpoint,
                Some(preparation),
                None,
            )));
        coordinator
            .run(&ycoding_schema::session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        fixture.finish().await;
        let requests = fixture.requests.lock().unwrap().clone();
        assert!(
            requests[0].starts_with("POST /oauth/token ")
                || requests[0].starts_with("POST /token ")
        );
        assert!(requests[0].contains("fixture-refresh"));
        assert!(requests[1].contains("authorization: Bearer fixture-prepared"));
        assert!(!requests[1].contains("fixture-expired"));
        let current = credentials.get(profile.id()).unwrap().unwrap();
        assert_eq!(current.account_generation(), profile.account_generation());
        assert!(
            stringify_json(&current.secret().domain().unwrap().encode())
                .contains("fixture-prepared")
        );
        coordinator.shutdown().await.unwrap();
        credentials.shutdown().await.unwrap();
        store.shutdown().unwrap();
    }
}

#[tokio::test]
async fn runner_exchanges_stored_cursor_api_key_before_route_authentication() {
    const CHAT: &str = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "profile".into(),
            "cursor".into(),
            Some("Work".into()),
            ycoding_store::resources::Secret::new(
                parse_json(r#"{"type":"key","key":"crsr_fixture"}"#).unwrap(),
            )
            .unwrap(),
            1,
        )
        .await
        .unwrap();
    let mut fixture = Fixture::new(vec![
        (
            200,
            "0",
            "{\"accessToken\":\"fixture-cursor-jwt\",\"refreshToken\":\"fixture-cursor-refresh\"}",
        ),
        (200, "0", CHAT),
    ])
    .await;
    let client = Client::new(&fixture.endpoint, "fixture").unwrap();
    let cursor = ycoding_core::resources::auth::cursor::Store::new(client.clone());
    let preparation = ycoding_core::resources::auth::Preparation {
        clients: BTreeMap::from([("cursor".into(), client)]),
        cursor: Some(cursor.clone()),
        providers: None,
    };
    admit(&store).await;
    let coordinator = ycoding_core::session::run_coordinator::Coordinator::new(Arc::new(runner(
        &store,
        "cursor",
        &fixture.endpoint,
        Some(preparation),
        None,
    )));
    coordinator
        .run(&ycoding_schema::session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    fixture.finish().await;
    let requests = fixture.requests.lock().unwrap().clone();
    assert!(requests[0].starts_with("POST /auth/exchange_user_api_key "));
    assert!(requests[0].contains("authorization: Bearer crsr_fixture"));
    assert!(requests[1].contains("authorization: Bearer fixture-cursor-jwt"));
    assert!(!requests[1].contains("crsr_fixture"));
    coordinator.shutdown().await.unwrap();
    cursor.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn runner_managed_claude_resolves_source_and_without_host_returns_reconnect_before_http() {
    let profiles = Profiles::new();
    profiles.write(A, "fixture-claude-token", FRESH);
    let store = support::store();
    let credentials = credential::Service::new(store.client());
    selected(&credentials, A, "Personal").await;
    let mut fixture = Fixture::new(vec![(200, "0.25", SUCCESS)]).await;
    admit(&store).await;
    let missing = ycoding_core::session::run_coordinator::Coordinator::new(Arc::new(runner(
        &store,
        "anthropic",
        &fixture.endpoint,
        None,
        None,
    )));
    let outcome = missing
        .run(&ycoding_schema::session::Id::new("ses_one").unwrap())
        .await;
    assert!(outcome.is_err());
    assert!(fixture.requests.lock().unwrap().is_empty());
    missing.shutdown().await.unwrap();
    let host = host(
        &store,
        profiles.store(&fixture.endpoint),
        credentials.clone(),
    );
    let coordinator = ycoding_core::session::run_coordinator::Coordinator::new(Arc::new(runner(
        &store,
        "anthropic",
        &fixture.endpoint,
        None,
        Some(host.clone()),
    )));
    coordinator
        .run(&ycoding_schema::session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    fixture.finish().await;
    let requests = fixture.requests.lock().unwrap().clone();
    assert!(requests[0].contains("authorization: Bearer fixture-claude-token"));
    assert!(!requests[0].contains(A));
    assert!(requests[0].contains("x-anthropic-billing-header"));
    assert!(requests[0].contains("x-ycoding-session: ses_one"));
    let affinity = requests[0]
        .lines()
        .find_map(|line| line.strip_prefix("x-session-id: "))
        .unwrap();
    assert_ne!(affinity, "ses_one");
    assert!(requests[0].contains("x-claude-code-session-id: ses_one"));
    let service = ycoding_core::session::store::Service::new(store.client());
    let assistant = service
        .context(&ycoding_schema::session::Id::new("ses_one").unwrap())
        .unwrap()
        .into_iter()
        .find_map(|message| {
            if let ycoding_schema::session_message::Info::Assistant(assistant) = message {
                Some(assistant)
            } else {
                None
            }
        })
        .unwrap();
    assert_eq!(
        assistant
            .diagnostics
            .unwrap()
            .provider_cache
            .unwrap()
            .mechanism
            .0
            .as_str(),
        Some("anthropic-cache-control")
    );
    coordinator.shutdown().await.unwrap();
    host.accounts.shutdown().await.unwrap();
    host.quota.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

fn p1_settings() -> Settings {
    Settings {
        version: "2.1.316".into(),
        entrypoint: "sdk-cli".into(),
        user_agent: "claude-cli/2.1.316 (external, sdk-cli)".into(),
        beta_flags: String::new(),
        debug_file: None,
    }
}

struct P1Account(&'static str);
impl Account for P1Account {
    fn resolve(&self, _force_refresh: bool) -> Resolution<'_> {
        Box::pin(async move {
            Ok(Credentials {
                access_token: Secret::new("fixture-access"),
                subscription_type: None,
            })
        })
    }
    fn billing_sample(&self, _session: &str) -> Option<ycoding_schema::LosslessString> {
        None
    }
    fn observe(
        &self,
        _observation: ycoding_schema::provider_usage::Observation,
    ) -> Result<(), claude_code::ObservationError> {
        Ok(())
    }
    fn profile_source(&self) -> Option<String> {
        Some(self.0.into())
    }
}

#[test]
fn claude_code_2_1_316_identity_betas_and_billing_fingerprint() {
    assert_eq!(Settings::default().version, "2.1.316");
    assert_eq!(
        Settings::default().user_agent,
        "claude-cli/2.1.316 (external, sdk-cli)"
    );
    let incoming = reqwest::header::HeaderMap::from_iter([(
        reqwest::header::HeaderName::from_static("anthropic-beta"),
        reqwest::header::HeaderValue::from_static(
            "advisor-tool-2026-03-01,extended-cache-ttl-2025-04-11,custom-feature",
        ),
    )]);
    let headers = claude_code::headers(
        incoming,
        &Credentials {
            access_token: Secret::new("fixture-access"),
            subscription_type: None,
        },
        &"claude-opus-5".into(),
        &p1_settings(),
        &std::collections::BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(headers["x-stainless-package-version"], "0.128.0");
    assert_eq!(
        headers["user-agent"],
        "claude-cli/2.1.316 (external, sdk-cli)"
    );
    assert_eq!(
        headers["anthropic-beta"],
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,thinking-token-count-2026-05-13,effort-2025-11-24,custom-feature"
    );
    let transformed = claude_code::transform_body(
        parse_json(
            r#"{"messages":[{"role":"user","isMeta":true,"content":"ignored"},{"role":"user","content":"Reply with OK"}]}"#,
        )
        .unwrap(),
        &p1_settings(),
        None,
    );
    let transformed: serde_json::Value =
        serde_json::from_str(&stringify_json(&transformed)).unwrap();
    assert_eq!(
        transformed["system"][0]["text"],
        "x-anthropic-billing-header: cc_version=2.1.316.346; cc_entrypoint=sdk-cli;"
    );
}

#[test]
fn claude_code_profile_identity_is_stable_per_profile_source() {
    let identity = |source: &'static str| {
        let route = claude_code::route(Arc::new(P1Account(source)), p1_settings());
        let mut request = Request::new(route.model("claude-opus-5"));
        request.cache = Policy::None;
        request.messages = vec![Message::user("hello")];
        request
            .http
            .headers
            .insert("x-session-id".into(), "ses_parity".into());
        let prepared = request.model.route.prepare(&request).unwrap();
        let body: serde_json::Value = serde_json::from_str(&prepared.encoded_body).unwrap();
        serde_json::from_str::<serde_json::Value>(body["metadata"]["user_id"].as_str().unwrap())
            .unwrap()
    };
    let first = identity("profile-a-u2");
    assert_eq!(first["account_uuid"], "");
    assert_eq!(first["session_id"], "ses_parity");
    let device = first["device_id"].as_str().unwrap();
    assert_eq!(device.len(), 64);
    assert!(device.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(identity("profile-a-u2"), first);
    assert_ne!(identity("profile-b-u2")["device_id"], first["device_id"]);
}

#[tokio::test]
async fn claude_code_betas_latch_per_profile_session_and_model() {
    let mut fixture = Fixture::new(vec![
        (
            429,
            "0.1",
            r#"{"error":{"message":"You're out of extra usage"}}"#,
        ),
        (200, "0.1", SUCCESS),
        (200, "0.1", SUCCESS),
    ])
    .await;
    let mut route = claude_code::route(Arc::new(P1Account("profile-latch-u2")), p1_settings());
    route.endpoint.base_url = format!("{}/v1", fixture.endpoint);
    let mut request = Request::new(route.model("claude-opus-5"));
    request.cache = Policy::None;
    request.messages = vec![Message::user("hello")];
    request
        .http
        .headers
        .insert("x-session-id".into(), "ses_latch_u2".into());
    request.tools = vec![ToolDefinition {
        name: "lookup".into(),
        description: "Lookup".into(),
        input_schema: parse_json(r#"{"type":"object","properties":{}}"#).unwrap(),
        output_schema: None,
        cache: Some(Hint::ephemeral(Some(3600.0))),
        metadata: None,
        native: None,
    }];
    let executor = Executor::new(Executor::http_client().unwrap());
    executor.generate(&request).await.unwrap();
    request.tools.clear();
    executor.generate(&request).await.unwrap();
    fixture.finish().await;
    let requests = fixture.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 3);
    let betas = |request: &str| {
        request
            .lines()
            .find_map(|line| line.strip_prefix("anthropic-beta: "))
            .unwrap()
            .to_owned()
    };
    assert!(
        !betas(&requests[0]).contains("advisor-tool"),
        "{}",
        requests[0]
    );
    assert!(
        betas(&requests[0]).contains("extended-cache-ttl-2025-04-11"),
        "{}",
        requests[0]
    );
    assert!(
        betas(&requests[0]).contains("interleaved-thinking-2025-05-14"),
        "{}",
        requests[0]
    );
    assert_eq!(betas(&requests[2]), betas(&requests[1]));
    assert!(!betas(&requests[1]).contains("interleaved-thinking-2025-05-14"));
    assert!(betas(&requests[2]).contains("extended-cache-ttl-2025-04-11"));
}
