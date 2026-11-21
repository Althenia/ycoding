use std::collections::BTreeMap;
use ycoding_core::resources::{auth::integration::Registry, credential::Service};
use ycoding_schema::{
    DomainEncode, connection, credential, integration, integration_id::IntegrationMethodId,
    schema::NonNegativeInt,
};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

fn store() -> Store {
    Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([8; 16], 1),
    )
    .unwrap()
}
fn key(value: &str) -> resources::Secret {
    resources::Secret::new(
        credential::Value::Key(credential::Key {
            key: value.into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}
fn oauth() -> resources::Secret {
    resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: IntegrationMethodId::new("fixture").unwrap(),
            access: "fixture-token".into(),
            refresh: "fixture-refresh".into(),
            expires: NonNegativeInt::new(9_000_000).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}
fn kind_of(
    connections: &[connection::Info],
    id: &ycoding_schema::LosslessString,
) -> Option<connection::CredentialKind> {
    connections.iter().find_map(|connection| match connection {
        connection::Info::Credential(value) if &value.id.0 == id => Some(value.kind),
        _ => None,
    })?
}

#[tokio::test]
async fn connections_emit_verified_kind_from_the_stored_credential() {
    let store = store();
    let service = Service::new(store.client());
    let key_credential = service
        .create(
            "key-profile".into(),
            "fixture".into(),
            Some("Key profile".into()),
            key("secret-key"),
            1,
        )
        .await
        .unwrap();
    let oauth_credential = service
        .create(
            "oauth-profile".into(),
            "fixture".into(),
            Some("OAuth profile".into()),
            oauth(),
            2,
        )
        .await
        .unwrap();
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let registration = registry
        .transform(|draft| {
            draft.method(
                "fixture".into(),
                integration::Method::Key(integration::KeyMethod { label: None }),
            )
        })
        .unwrap();
    let connections = registry
        .get(&"fixture".into())
        .unwrap()
        .unwrap()
        .connections;
    assert_eq!(
        kind_of(&connections, key_credential.id()),
        Some(connection::CredentialKind::Key)
    );
    assert_eq!(
        kind_of(&connections, oauth_credential.id()),
        Some(connection::CredentialKind::Oauth)
    );
    let active = registry.active(&"fixture".into()).unwrap().unwrap();
    let connection::Info::Credential(active) = active else {
        panic!("active connection is not a credential")
    };
    assert_eq!(active.kind, Some(connection::CredentialKind::Oauth));
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn snapshot_overrides_caller_kind_and_omits_kind_for_a_missing_credential() {
    let store = store();
    let service = Service::new(store.client());
    let stored = service
        .create(
            "oauth-profile".into(),
            "fixture".into(),
            Some("OAuth profile".into()),
            oauth(),
            1,
        )
        .await
        .unwrap();
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let snapshot = registry
        .snapshot(
            connection::Info::Credential(connection::CredentialInfo {
                id: credential::Id(stored.id().clone()),
                label: stored.label().clone(),
                active: true,
                kind: Some(connection::CredentialKind::Key),
                status: None,
                message: None,
            }),
            0,
        )
        .await
        .unwrap();
    assert!(snapshot.credential.is_some());
    let connection::Info::Credential(resolved) = &snapshot.connection else {
        panic!("snapshot connection is not a credential")
    };
    assert_eq!(resolved.kind, Some(connection::CredentialKind::Oauth));
    let missing = registry
        .snapshot(
            connection::Info::Credential(connection::CredentialInfo {
                id: credential::Id("missing".into()),
                label: "Missing".into(),
                active: true,
                kind: Some(connection::CredentialKind::Oauth),
                status: None,
                message: None,
            }),
            0,
        )
        .await
        .unwrap();
    assert!(missing.credential.is_none());
    let connection::Info::Credential(resolved) = &missing.connection else {
        panic!("missing snapshot connection is not a credential")
    };
    assert_eq!(resolved.kind, None);
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
