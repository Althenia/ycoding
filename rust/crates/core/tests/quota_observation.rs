use std::collections::BTreeMap;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::resources::{
    credential,
    model::quota::{Endpoints, Service},
};
use ycoding_schema::{DomainEncode, provider, provider_usage, schema::NonNegativeInt};
use ycoding_store::{Metadata, Options, Store, resources};

fn observation(used: f64) -> provider_usage::Observation {
    provider_usage::Observation {
        provider_id: provider::Id("openrouter".into()),
        label: "OpenRouter".into(),
        source: "response_stream".into(),
        stability: "observed".into(),
        observed_at: NonNegativeInt::new(200).unwrap(),
        windows: vec![provider_usage::Window {
            id: "window".into(),
            label: "Window".into(),
            unit: "percent".into(),
            used: Some(used),
            limit: None,
            remaining: None,
            unlimited: None,
            reset_at: None,
            period_seconds: None,
        }],
    }
}

async fn refreshed(responses: Vec<(u16, &'static str)>) -> (Service, provider_usage::Snapshot) {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([12; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "observed-key".into(),
            "openrouter".into(),
            None,
            resources::Secret::new(
                ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
                    key: "fixture-key".into(),
                    metadata: None,
                })
                .encode(),
            )
            .unwrap(),
            0,
        )
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        for ((status, body), path) in responses.into_iter().zip(["/key", "/credits"]) {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 4096];
            let size = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8(bytes[..size].to_vec()).unwrap();
            assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
            socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
    });
    let usage = Service::new(
        credentials,
        Endpoints(BTreeMap::from([("openrouter".into(), endpoint)])),
    )
    .unwrap();
    usage.observe(observation(42.0), None).unwrap();
    let snapshot = usage
        .get(provider::Id("openrouter".into()), None, true, 300)
        .await;
    worker.await.unwrap();
    (usage, snapshot)
}

#[tokio::test]
async fn refresh_without_selected_credential_keeps_stored_observation() {
    let store = Store::disposable(
        Options::core(),
        ycoding_store::Catalog::new(1, resources::TABLES),
        Metadata::new([12; 16], 1),
    )
    .unwrap();
    let usage = Service::new(
        credential::Service::new(store.client()),
        Endpoints::provider(),
    )
    .unwrap();
    usage.observe(observation(42.0), None).unwrap();
    let observed = usage
        .get(provider::Id("openrouter".into()), None, false, 200)
        .await;
    assert_eq!(observed.status, "available".into());
    assert_eq!(observed.windows[0].used, Some(42.0));
    assert_eq!(
        usage
            .get(provider::Id("openrouter".into()), None, true, 300)
            .await,
        observed
    );
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn refresh_with_empty_unsupported_snapshot_keeps_older_observation() {
    let (usage, snapshot) = refreshed(vec![(404, "{}")]).await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.updated_at, NonNegativeInt::new(200).unwrap());
    assert_eq!(snapshot.source, "response_stream".into());
    assert_eq!(snapshot.stability, "observed".into());
    assert_eq!(snapshot.windows[0].used, Some(42.0));
    usage.shutdown().await.unwrap();
}

#[tokio::test]
async fn refresh_with_newer_supported_snapshot_replaces_observation() {
    let (usage, snapshot) =
        refreshed(vec![(200, r#"{"data":{"usage_daily":0}}"#), (403, "{}")]).await;
    assert_eq!(snapshot.status, "available".into());
    assert_eq!(snapshot.updated_at, NonNegativeInt::new(300).unwrap());
    assert_eq!(snapshot.source, "provider_api".into());
    assert_eq!(snapshot.windows[0].used, Some(0.0));
    usage.shutdown().await.unwrap();
}
