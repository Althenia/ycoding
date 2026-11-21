use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_core::resources::{config::Roots, credential::Service};
use ycoding_schema::{DomainEncode, credential};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[tokio::test]
async fn credentials_and_binding_survive_reopen_with_bounded_pages_and_development_roots() {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-auth-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let roots = Roots::development(&directory).unwrap();
    roots.initialize().unwrap();
    let path = roots.data.join("credentials.redb");
    let catalog = Catalog::new(1, resources::TABLES);
    let store =
        Store::initialize(&path, Options::core(), catalog, Metadata::new([13; 16], 1)).unwrap();
    let service = Service::new(store.client());
    for index in 0..130 {
        let secret = resources::Secret::new(
            credential::Value::Key(credential::Key {
                key: "fixture-secret".into(),
                metadata: None,
            })
            .encode(),
        )
        .unwrap();
        service
            .create(
                format!("id-{index:03}").into(),
                "test".into(),
                Some(format!("Profile {index}").into()),
                secret,
                index,
            )
            .await
            .unwrap();
    }
    let binding = service
        .bind("test".into(), "test".into(), "Profile 0".into())
        .unwrap();
    assert_eq!(service.all().unwrap().len(), 130);
    service.activate("id-000".into(), 131).await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
    let store = Store::open(&path, Options::core(), catalog).unwrap();
    let service = Service::new(store.client());
    assert!(service.resolve_binding(&binding).unwrap().active());
    service.remove("id-000".into(), 132).await.unwrap();
    assert_eq!(
        service
            .active(&"test".into())
            .unwrap()
            .unwrap()
            .label()
            .as_str(),
        Some("Profile 129")
    );
    assert_eq!(service.list(&"test".into()).unwrap().len(), 129);
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
