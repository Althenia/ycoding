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
use ycoding_schema::{DomainEncode, parse_json, provider};
use ycoding_store::{Metadata, Options, Store, resources};

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
