use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use ycoding_core::resources::{
    auth::integration::{Authorization, Event, OAuthImplementation, Registry},
    credential::{Error, Service},
};
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

#[tokio::test]
async fn draft_reference_order_and_equal_name_ties_preserve_ts_map_insertion_order() {
    let store = store();
    let registry = Registry::new(Service::new(store.client()), BTreeMap::new());
    let first = registry.transform(|draft| {
        draft.update("z".into(), |item| item.name = "Same".into());
        draft.update("a".into(), |item| item.name = "Same".into());
        assert_eq!(
            draft
                .references()
                .iter()
                .map(|item| item.id.as_lossless().clone())
                .collect::<Vec<_>>(),
            vec!["z".into(), "a".into()]
        );
    });
    let first = first.unwrap();
    assert_eq!(
        registry
            .list_by(|_, _| std::cmp::Ordering::Equal)
            .unwrap()
            .iter()
            .map(|item| item.id.as_lossless().clone())
            .collect::<Vec<_>>(),
        vec!["z".into(), "a".into()]
    );
    first.dispose().unwrap();
    registry.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn scoped_transforms_restore_previous_registration_and_deduplicate_method_identity() {
    let store = store();
    let registry = Registry::new(Service::new(store.client()), BTreeMap::new());
    let mut events = registry.subscribe();
    let first = registry
        .transform(|draft| {
            draft.update("fixture".into(), |item| {
                item.name = "First".into();
                item.id = ycoding_schema::integration_id::IntegrationId::new("wrong").unwrap();
            });
            draft.method(
                "fixture".into(),
                integration::Method::Key(integration::KeyMethod {
                    label: Some("Key".into()),
                }),
            );
        })
        .unwrap();
    assert_eq!(events.recv().await.unwrap(), Event::Updated);
    let second = registry
        .transform(|draft| {
            draft.update("fixture".into(), |item| item.name = "Override".into());
            draft.method(
                "fixture".into(),
                integration::Method::Key(integration::KeyMethod {
                    label: Some("Overridden".into()),
                }),
            );
        })
        .unwrap();
    assert_eq!(
        registry.get(&"fixture".into()).unwrap().unwrap().name,
        "Override".into()
    );
    assert_eq!(
        registry
            .get(&"fixture".into())
            .unwrap()
            .unwrap()
            .id
            .as_lossless(),
        &"fixture".into()
    );
    assert_eq!(
        registry
            .get(&"fixture".into())
            .unwrap()
            .unwrap()
            .methods
            .len(),
        1
    );
    second.dispose().unwrap();
    assert_eq!(
        registry.get(&"fixture".into()).unwrap().unwrap().name,
        "First".into()
    );
    first.dispose().unwrap();
    assert!(registry.get(&"fixture".into()).unwrap().is_none());
    registry.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn stored_active_then_newest_profiles_precede_environment_method_order() {
    let store = store();
    let service = Service::new(store.client());
    let first = service
        .create(
            "a".into(),
            "fixture".into(),
            Some("First".into()),
            key("secret-a"),
            1,
        )
        .await
        .unwrap();
    let second = service
        .create(
            "b".into(),
            "fixture".into(),
            Some("Second".into()),
            key("secret-b"),
            2,
        )
        .await
        .unwrap();
    service.activate(first.id().clone(), 3).await.unwrap();
    let registry = Registry::new(
        service.clone(),
        BTreeMap::from([
            ("PRIMARY".into(), "env-one".into()),
            ("SECONDARY".into(), "env-two".into()),
            ("EMPTY".into(), "".into()),
        ]),
    );
    let registration = registry
        .transform(|draft| {
            draft.method(
                "fixture".into(),
                integration::Method::Env(integration::EnvMethod {
                    names: vec!["SECONDARY".into(), "EMPTY".into(), "PRIMARY".into()],
                }),
            )
        })
        .unwrap();
    let connections = registry
        .get(&"fixture".into())
        .unwrap()
        .unwrap()
        .connections;
    assert!(
        matches!(&connections[0], connection::Info::Credential(value) if &value.id.0 == first.id() && value.active)
    );
    assert!(
        matches!(&connections[1], connection::Info::Credential(value) if &value.id.0 == second.id() && !value.active)
    );
    assert!(
        matches!(&connections[2], connection::Info::Env(value) if value.name == "SECONDARY".into())
    );
    assert!(
        matches!(&connections[3], connection::Info::Env(value) if value.name == "PRIMARY".into())
    );
    let snapshot = registry.snapshot(connections[2].clone(), 0).await.unwrap();
    assert!(snapshot.credential.is_none());
    assert!(
        matches!(snapshot.value.unwrap().domain().unwrap(), credential::Value::Key(value) if value.key == "env-two".into())
    );
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn connection_events_are_ordered_after_successful_storage_and_exclude_secrets() {
    let store = store();
    let service = Service::new(store.client());
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let registration = registry
        .transform(|draft| {
            draft.method(
                "fixture".into(),
                integration::Method::Key(integration::KeyMethod { label: None }),
            )
        })
        .unwrap();
    let mut events = registry.subscribe();
    registry
        .login_key("fixture".into(), None, "fixture-secret".into(), 100)
        .await
        .unwrap();
    let event = events.recv().await.unwrap();
    assert_eq!(event, Event::ConnectionUpdated("fixture".into()));
    assert_eq!(events.recv().await.unwrap(), Event::Updated);
    assert_eq!(service.list(&"fixture".into()).unwrap().len(), 1);
    assert!(!format!("{event:?}").contains("fixture-secret"));
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn manual_attempt_ownership_code_requirement_terminal_retention_and_expiry() {
    let store = store();
    let service = Service::new(store.client());
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let registration = registry
        .transform(|draft| {
            draft.oauth(OAuthImplementation {
                integration: "fixture".into(),
                method: integration::OAuthMethod {
                    id: IntegrationMethodId::new("fixture").unwrap(),
                    label: "Fixture".into(),
                    prompts: None,
                    remote: Some(true),
                },
                authorize: Arc::new(|_| {
                    Box::pin(async {
                        Ok(Authorization::code(
                            "https://example.invalid".into(),
                            "Paste code".into(),
                            Arc::new(|code| {
                                Box::pin(async move {
                                    if code != "code" {
                                        return Err(Error::Rejected);
                                    }
                                    Ok(oauth())
                                })
                            }),
                        ))
                    })
                }),
                refresh: None,
                label: None,
            })
        })
        .unwrap();
    let attempt = registry
        .connect(
            "fixture".into(),
            "fixture".into(),
            integration::Inputs(ycoding_schema::JsonObject::new()),
            None,
            0,
        )
        .await
        .unwrap();
    assert_eq!(
        registry
            .complete(&"foreign".into(), &attempt.attempt_id, Some("code"), 0)
            .await
            .unwrap_err(),
        Error::Rejected
    );
    assert_eq!(
        registry
            .complete(&"fixture".into(), &attempt.attempt_id, None, 1)
            .await
            .unwrap_err(),
        Error::CodeRequired
    );
    registry
        .complete(&"fixture".into(), &attempt.attempt_id, Some("code"), 2)
        .await
        .unwrap();
    registry
        .complete(&"fixture".into(), &attempt.attempt_id, Some("code"), 3)
        .await
        .unwrap();
    assert!(matches!(
        registry
            .status(&"fixture".into(), &attempt.attempt_id)
            .unwrap(),
        integration::AttemptStatus::Complete(_)
    ));
    assert_eq!(service.list(&"fixture".into()).unwrap().len(), 1);
    registry.scrub(60_001).await.unwrap();
    assert!(
        registry
            .status(&"fixture".into(), &attempt.attempt_id)
            .is_ok()
    );
    registry.scrub(60_002).await.unwrap();
    assert!(
        registry
            .status(&"fixture".into(), &attempt.attempt_id)
            .is_err()
    );
    let attempt = registry
        .connect(
            "fixture".into(),
            "fixture".into(),
            integration::Inputs(ycoding_schema::JsonObject::new()),
            None,
            100_000,
        )
        .await
        .unwrap();
    registry.scrub(700_000).await.unwrap();
    assert!(matches!(
        registry
            .status(&"fixture".into(), &attempt.attempt_id)
            .unwrap(),
        integration::AttemptStatus::Expired(_)
    ));
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn command_attempt_is_not_visible_through_oauth_lookup() {
    let store = store();
    let service = Service::new(store.client());
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let registration = registry
        .transform(|draft| {
            draft.method(
                "fixture".into(),
                integration::Method::Command(integration::CommandMethod {
                    id: IntegrationMethodId::new("command").unwrap(),
                    label: "Command".into(),
                    command: vec!["/usr/bin/printf".into(), "fixture-key\n".into()],
                }),
            )
        })
        .unwrap();
    let mut events = registry.subscribe();
    let attempt = registry
        .connect_command("fixture".into(), "command".into(), None, 0)
        .await
        .unwrap();
    assert!(
        registry
            .status(&"fixture".into(), &attempt.attempt_id)
            .is_err()
    );
    assert!(
        registry
            .command_status(&"fixture".into(), &attempt.attempt_id)
            .is_ok()
    );
    assert_eq!(
        events.recv().await.unwrap(),
        Event::ConnectionUpdated("fixture".into())
    );
    assert!(matches!(
        registry
            .command_status(&"fixture".into(), &attempt.attempt_id)
            .unwrap(),
        integration::CommandAttemptStatus::Complete(_)
    ));
    assert!(
        matches!(service.list(&"fixture".into()).unwrap()[0].secret().domain().unwrap(),credential::Value::Key(value) if value.key == "fixture-key".into())
    );
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    assert!(matches!(
        registry
            .command_status(&"fixture".into(), &attempt.attempt_id)
            .unwrap(),
        integration::CommandAttemptStatus::Complete(_)
    ));
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}

#[tokio::test]
async fn automatic_attempt_cancel_drops_owned_exchange_and_cannot_store_or_publish_connection() {
    let store = store();
    let service = Service::new(store.client());
    let registry = Registry::new(service.clone(), BTreeMap::new());
    let (started, ready) = tokio::sync::oneshot::channel();
    let (release, blocked) = tokio::sync::oneshot::channel::<()>();
    let input = Arc::new(Mutex::new(Some((started, blocked))));
    let registration = registry
        .transform(move |draft| {
            let input = input.clone();
            draft.oauth(OAuthImplementation {
                integration: "fixture".into(),
                method: integration::OAuthMethod {
                    id: IntegrationMethodId::new("automatic").unwrap(),
                    label: "Automatic".into(),
                    prompts: None,
                    remote: None,
                },
                authorize: Arc::new(move |_| {
                    let (started, blocked) = input.lock().unwrap().take().unwrap();
                    Box::pin(async move {
                        Ok(Authorization::automatic(
                            "https://example.invalid".into(),
                            "Wait".into(),
                            Box::pin(async move {
                                let _ = started.send(());
                                blocked.await.map_err(|_| Error::Rejected)?;
                                Ok(oauth())
                            }),
                            None,
                            None,
                        ))
                    })
                }),
                refresh: None,
                label: None,
            });
        })
        .unwrap();
    let mut events = registry.subscribe();
    let attempt = registry
        .connect(
            "fixture".into(),
            "automatic".into(),
            integration::Inputs(ycoding_schema::JsonObject::new()),
            None,
            0,
        )
        .await
        .unwrap();
    ready.await.unwrap();
    registry
        .cancel(&"fixture".into(), &attempt.attempt_id)
        .await
        .unwrap();
    assert!(release.send(()).is_err());
    assert!(service.list(&"fixture".into()).unwrap().is_empty());
    assert!(events.try_recv().is_err());
    assert!(
        registry
            .status(&"fixture".into(), &attempt.attempt_id)
            .is_err()
    );
    registration.dispose().unwrap();
    registry.shutdown().await.unwrap();
    service.shutdown().await.unwrap();
    store.shutdown().unwrap();
}
