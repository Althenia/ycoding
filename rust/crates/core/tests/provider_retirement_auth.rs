use ycoding_core::resources::{
    auth::{Client, Preparation, integration::Registry},
    credential::{Error, Service},
};
use ycoding_schema::{JsonObject, integration};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

#[tokio::test]
async fn retired_authorization_rejects_new_attempts_and_preserves_saved_credentials() {
    let store = Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([17; 16], 1),
    )
    .unwrap();
    let credentials = Service::new(store.client());
    let registry = Registry::new(credentials.clone(), Default::default());
    let client = Client::new("http://127.0.0.1:9", "fixture").unwrap();
    let secret = resources::Secret::new(
        ycoding_schema::parse_json(r#"{"type":"oauth","methodID":"device","refresh":"synthetic-refresh","access":"synthetic-access","expires":9007199254740991}"#).unwrap(),
    )
    .unwrap();
    for (provider, method) in [("antigravity", "google"), ("muse", "device")] {
        let id = provider.into();
        let saved = credentials
            .create(
                format!("saved-{provider}").into(),
                provider.into(),
                None,
                secret.clone(),
                0,
            )
            .await
            .unwrap();
        let error = Client::provider(provider, "fixture").unwrap_err();
        assert_eq!(error.to_string(), "Provider no longer supported");
        assert_eq!(
            client
                .start_code(provider, method, "http://localhost:9999/callback")
                .unwrap_err(),
            Error::ProviderRetired
        );
        assert_eq!(
            registry
                .connect(
                    id,
                    method.into(),
                    integration::Inputs(JsonObject::new()),
                    None,
                    0
                )
                .await
                .err(),
            Some(Error::ProviderRetired)
        );
        assert_eq!(
            Preparation::default()
                .prepare_value(&credentials, saved.clone(), 0, None)
                .await
                .err(),
            Some(Error::ProviderRetired)
        );
        let integration::RefreshResult::Failed { message } =
            registry.refresh(saved.id(), 0).await.unwrap()
        else {
            panic!("retired credentials must not refresh");
        };
        assert_eq!(message.as_str(), Some("Provider no longer supported"));
        assert_eq!(
            credentials.list(&provider.into()).unwrap().as_slice(),
            &[saved]
        );
    }
    registry.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}
