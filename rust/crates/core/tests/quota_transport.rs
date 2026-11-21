use std::collections::BTreeMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};
use ycoding_core::resources::{
    catalog::{Catalog, models_dev},
    credential,
    model::{
        Resolver,
        quota::{Endpoints, Service},
    },
};
use ycoding_schema::{DomainDecode, DomainEncode, parse_json, provider};
use ycoding_store::{Metadata, Options, Store, native, resources};

#[path = "report_support/prepared.rs"]
mod prepared_support;
#[path = "report_support/quota.rs"]
mod quota_support;
mod report_support;

#[tokio::test]
async fn quota_refresh_is_read_only_does_not_block_resolution_and_fences_replaced_account() {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([10; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let secret = resources::Secret::new(
        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: "fixture-key".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let saved = credentials
        .create(
            "fixture-id".into(),
            "openrouter".into(),
            Some("Work".into()),
            secret.clone(),
            0,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let worker = tokio::spawn(async move {
        let mut entered = Some(entered_tx);
        let mut release = Some(release_rx);
        for (path, status, body) in [
            ("/key", 200, r#"{"data":{"usage_daily":0}}"#),
            ("/credits", 403, r#"{}"#),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let size = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
            assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
            assert!(
                request
                    .to_lowercase()
                    .contains("authorization: bearer fixture-key")
            );
            if let Some(entered) = entered.take() {
                entered.send(()).unwrap();
                release.take().unwrap().await.unwrap();
            }
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
    });
    let usage = Service::new(
        credentials.clone(),
        Endpoints(BTreeMap::from([("openrouter".into(), endpoint)])),
    )
    .unwrap();
    let pending = {
        let usage = usage.clone();
        tokio::spawn(async move {
            usage
                .get(provider::Id("openrouter".into()), None, false, 100)
                .await
        })
    };
    entered_rx.await.unwrap();
    assert_eq!(credentials.get(saved.id()).unwrap().unwrap(), saved);
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog
        .configure(&[
            parse_json(r#"{"providers":{"openai":{"settings":{"apiKey":"fixture"}}}}"#).unwrap(),
        ])
        .unwrap();
    let selection = ycoding_schema::model::Ref {
        id: "gpt-reasoning".into(),
        provider_id: provider::Id("openai".into()),
        variant: None,
        profile: None,
    };
    assert!(
        Resolver::new(catalog)
            .resolve(&selection, &[], None)
            .is_ok()
    );
    credentials
        .create(
            "ignored".into(),
            "openrouter".into(),
            Some("Work".into()),
            secret,
            1,
        )
        .await
        .unwrap();
    release_tx.send(()).unwrap();
    let result = pending.await.unwrap();
    assert_eq!(result.status, "unsupported".into());
    assert_eq!(
        result.message,
        Some("Provider usage account changed during refresh".into())
    );
    assert!(result.windows.is_empty());
    assert!(!format!("{result:?}").contains("fixture-key"));
    assert!(!format!("{result:?}").contains("fixture-id"));
    worker.await.unwrap();
    usage.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}

#[tokio::test]
async fn copilot_http_billing_composition_reuses_org_and_sends_current_version_headers() {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([14; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let secret = resources::Secret::new(
        ycoding_schema::credential::Value::OAuth(ycoding_schema::credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("device").unwrap(),
            refresh: "fixture-token".into(),
            access: "fixture-access".into(),
            expires: ycoding_schema::schema::NonNegativeInt::new(0).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    credentials
        .create(
            "fixture-copilot".into(),
            "github-copilot".into(),
            Some("Work".into()),
            secret,
            0,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        for (path, body) in [
            ("/copilot_internal/user", r#"{"token_based_billing":true}"#),
            ("/user/orgs", r#"[{"login":"fixture-org"}]"#),
            (
                "/orgs/fixture-org/settings/billing/usage/summary",
                r#"{"usageItems":[{"product":"Copilot","unitType":"ai-credits","grossQuantity":10,"netAmount":1}]}"#,
            ),
            ("/copilot_internal/user", r#"{"token_based_billing":true}"#),
            (
                "/orgs/fixture-org/settings/billing/usage/summary",
                r#"{"usageItems":[{"product":"Copilot","unitType":"ai-credits","grossQuantity":20,"netAmount":2}]}"#,
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let size = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
            assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
            let lower = request.to_lowercase();
            for header in [
                "authorization: token fixture-token",
                "user-agent: ycoding/fixture",
                "editor-version: ycoding/fixture",
                "editor-plugin-version: ycoding/fixture",
                "x-github-api-version: 2025-04-01",
            ] {
                assert!(lower.contains(header));
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    let service = Service::new(
        credentials.clone(),
        Endpoints(BTreeMap::from([("github-copilot".into(), endpoint)])),
    )
    .unwrap()
    .with_version("fixture");
    let first = service
        .get(provider::Id("github-copilot".into()), None, false, 100)
        .await;
    assert_eq!(first.windows[0].used, Some(10.0));
    let second = service
        .get(provider::Id("github-copilot".into()), None, true, 200)
        .await;
    assert_eq!(second.windows[0].used, Some(20.0));
    assert_eq!(second.source, "provider_api".into());
    worker.await.unwrap();
    service.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}

#[tokio::test]
async fn rotated_credential_generation_keeps_stale_windows_and_never_serves_unloaded_generation() {
    let (store, credentials, saved) = grok_account([15; 16]).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        for (token, status, body) in [
            ("fixture-access-0", 200, grok(25)),
            ("fixture-access-1", 503, "{}".into()),
        ] {
            let (mut socket, received) = accept_billing(&listener).await;
            assert_eq!(received, token);
            respond(&mut socket, status, &body).await;
        }
    });
    let usage = Service::new(
        credentials.clone(),
        Endpoints(BTreeMap::from([("xai".into(), endpoint)])),
    )
    .unwrap();
    let usage = usage.with_store(store.client());
    let xai = provider::Id("xai".into());
    let first = usage.get(xai.clone(), None, false, 100).await;
    assert_eq!(first.status, "available".into());
    assert_eq!(first.windows[0].used, Some(25.0));
    let _reports = report_support::start(store.client());
    let views = ycoding_core::usage_view::Service::new(
        ycoding_core::session::store::Service::new(store.client()),
        None,
    );
    prepared_support::publish(&store.client(), &views);
    publish_xai(&usage, &views, 150).await;
    assert!(xai_quotas(&usage) > 0);

    let rotated = rotate(&credentials, &saved, 1, 200).await;
    assert_eq!(rotated.generation(), saved.generation() + 1);
    assert_eq!(rotated.account_generation(), saved.account_generation());
    assert_eq!(xai_quotas(&usage), 0);

    let second = usage.get(xai, None, false, 1_000).await;
    worker.await.unwrap();
    assert_eq!(second.status, "stale".into());
    assert_eq!(second.message, Some("Provider usage refresh failed".into()));
    assert_eq!(second.windows, first.windows);
    assert_eq!(second.updated_at, first.updated_at);
    assert_eq!(second.source, first.source);
    assert_eq!(second.stability, first.stability);
    for snapshot in [&first, &second] {
        let debug = format!("{snapshot:?}");
        assert!(!debug.contains("fixture-access"));
        assert!(!debug.contains("fixture-grok"));
    }
    usage.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    drop(store);
}

#[tokio::test]
async fn older_generation_refresh_completing_late_neither_joins_nor_replaces_rotated_quota() {
    let (store, credentials, saved) = grok_account([16; 16]).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (entered_tx, entered_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let worker = tokio::spawn(async move {
        let (mut older, token) = accept_billing(&listener).await;
        assert_eq!(token, "fixture-access-0");
        entered_tx.send(()).unwrap();
        let (mut rotated, token) = accept_billing(&listener).await;
        assert_eq!(token, "fixture-access-1");
        respond(&mut rotated, 200, &grok(50)).await;
        release_rx.await.unwrap();
        respond(&mut older, 200, &grok(10)).await;
    });
    let usage = Service::new(
        credentials.clone(),
        Endpoints(BTreeMap::from([("xai".into(), endpoint)])),
    )
    .unwrap();
    let usage = usage.with_store(store.client());
    let xai = provider::Id("xai".into());
    let pending = {
        let usage = usage.clone();
        let xai = xai.clone();
        tokio::spawn(async move { usage.get(xai, None, false, 100).await })
    };
    entered_rx.await.unwrap();
    rotate(&credentials, &saved, 1, 150).await;
    let rotated = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        usage.get(xai.clone(), None, false, 200),
    )
    .await
    .expect("a rotated generation must not join the older pending refresh");
    assert_eq!(rotated.status, "available".into());
    assert_eq!(rotated.windows[0].used, Some(50.0));
    release_tx.send(()).unwrap();
    pending.await.unwrap();
    worker.await.unwrap();

    let cached = usage.get(xai, None, false, 300).await;
    assert_eq!(cached.status, "available".into());
    assert_eq!(cached.windows[0].used, Some(50.0));
    assert_eq!(cached.windows.len(), 2);
    let publication = quota_support::publish(
        &store.client(),
        &usage,
        &[provider::Id("xai".into())],
        &quota_location(),
        350,
    )
    .await;
    assert_eq!(publication.backend.quotas.as_ref().unwrap().len(), 2);
    usage.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
    drop(store);
}

fn grok_secret(access: &str) -> resources::Secret {
    resources::Secret::new(
        ycoding_schema::credential::Value::OAuth(ycoding_schema::credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("browser").unwrap(),
            refresh: "fixture-grok-refresh".into(),
            access: access.into(),
            expires: ycoding_schema::schema::NonNegativeInt::new(4_000_000_000_000).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

async fn grok_account(seed: [u8; 16]) -> (Store, credential::Service, credential::Info) {
    let store = Store::disposable(
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new(seed, 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let saved = credentials
        .create(
            "fixture-grok".into(),
            "xai".into(),
            Some("Work".into()),
            grok_secret("fixture-access-0"),
            0,
        )
        .await
        .unwrap();
    (store, credentials, saved)
}

async fn rotate(
    credentials: &credential::Service,
    expected: &credential::Info,
    index: usize,
    now: i64,
) -> credential::Info {
    let secret = grok_secret(&format!("fixture-access-{index}"));
    credentials
        .refresh(expected.clone(), now, async move { Ok(secret) })
        .await
        .unwrap()
        .unwrap()
}

fn quota_location() -> ycoding_schema::location::Ref {
    ycoding_schema::location::Ref::decode(&parse_json(r#"{"directory":"/synthetic"}"#).unwrap())
        .unwrap()
}

async fn publish_xai(usage: &Service, views: &ycoding_core::usage_view::Service, now: i64) {
    assert!(
        usage
            .publish(
                views,
                &quota_location(),
                0,
                &[provider::Id("xai".into())],
                ycoding_schema::schema::NonNegativeInt::new(now).unwrap()
            )
            .await
            .unwrap()
    );
}

fn xai_quotas(usage: &Service) -> usize {
    usage
        .prepared(&quota_location(), 0)
        .unwrap()
        .map_or(0, |value| {
            value
                .backend
                .quotas
                .as_ref()
                .unwrap()
                .iter()
                .filter(|quota| quota.provider_id == provider::Id("xai".into()))
                .count()
        })
}

fn grok(percent: u32) -> String {
    format!(
        r#"{{"config":{{"creditUsagePercent":{percent},"currentPeriod":{{"type":"USAGE_PERIOD_TYPE_WEEKLY","start":"2026-09-21T00:00:00Z","end":"2026-09-28T00:00:00Z"}}}}}}"#
    )
}

async fn accept_billing(listener: &TcpListener) -> (tokio::net::TcpStream, String) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = vec![0; 4096];
    let size = socket.read(&mut bytes).await.unwrap();
    let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
    assert!(
        request.starts_with("GET /billing?format=credits HTTP/1.1"),
        "{request}"
    );
    let token = request
        .lines()
        .find_map(|line| {
            line.to_lowercase()
                .strip_prefix("authorization: bearer ")
                .map(str::to_owned)
        })
        .unwrap();
    (socket, token)
}

async fn respond(socket: &mut tokio::net::TcpStream, status: u16, body: &str) {
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
