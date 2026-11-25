use std::collections::BTreeMap;
use tokio::net::TcpListener;
use ycoding_core::resources::{
    credential,
    model::quota::{Endpoints, Service},
};
use ycoding_schema::{parse_json, provider, provider_usage, schema::NonNegativeInt};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

#[tokio::test]
async fn retired_quotas_reject_direct_reads_and_observations_without_requesting_endpoints() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([19; 16], 1),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let ids = ["antigravity", "muse"];
    let service = Service::new(
        credentials.clone(),
        Endpoints(BTreeMap::from(ids.map(|id| (id.into(), endpoint.clone())))),
    )
    .unwrap();
    let secret =
        resources::Secret::new(parse_json(r#"{"type":"key","key":"synthetic-key"}"#).unwrap())
            .unwrap();
    let ids = ids.map(|id| provider::Id(id.into()));
    for id in &ids {
        let saved = credentials
            .create(
                format!("saved-{}", id.0.as_str().unwrap()).into(),
                id.0.clone(),
                None,
                secret.clone(),
                0,
            )
            .await
            .unwrap();
        let rejected = service
            .observe(
                provider_usage::Observation {
                    provider_id: id.clone(),
                    label: "Synthetic quota".into(),
                    source: "response_stream".into(),
                    stability: "observed".into(),
                    observed_at: NonNegativeInt::new(99).unwrap(),
                    windows: vec![],
                },
                None,
            )
            .unwrap_err();
        assert_eq!(rejected.to_string(), "Provider no longer supported");
        let snapshot = tokio::select! {
            snapshot = service.get(id.clone(), Some(saved.id()), true, 100) => snapshot,
            _ = listener.accept() => panic!("retired quota contacted its endpoint"),
        };
        assert_eq!(snapshot.status.as_str(), Some("unsupported"));
        assert_eq!(
            snapshot.message.as_ref().and_then(|value| value.as_str()),
            Some("Provider no longer supported")
        );
        assert!(snapshot.profile.is_none() && snapshot.windows.is_empty());
        assert_eq!(credentials.list(&id.0).unwrap().as_slice(), &[saved]);
    }
    assert!(service.list(&ids, true, 100).await.is_empty());
    service.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}
