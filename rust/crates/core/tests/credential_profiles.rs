use ycoding_core::resources::credential::{Error, Service};
use ycoding_schema::{DomainEncode, credential, schema::NonNegativeInt};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

fn store() -> Store {
    Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([7; 16], 1),
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

fn oauth(access: &str, expires: i64) -> resources::Secret {
    resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: ycoding_schema::integration_id::IntegrationMethodId::new("test").unwrap(),
            access: access.into(),
            refresh: "fixture-refresh".into(),
            expires: NonNegativeInt::new(expires).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

#[tokio::test]
async fn named_profiles_store_update_activate_remove_and_redact() {
    let store = store();
    let service = Service::new(store.client());
    let work = service
        .create(
            "fixture-id-a".into(),
            "openai".into(),
            Some("Work".into()),
            key("fixture-secret-a"),
            1,
        )
        .await
        .unwrap();
    let personal = service
        .create(
            "fixture-id-b".into(),
            "openai".into(),
            Some("Personal".into()),
            key("fixture-secret-b"),
            2,
        )
        .await
        .unwrap();
    let listed = service.list(&"openai".into()).unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|v| v.label().as_str().unwrap())
            .collect::<Vec<_>>(),
        ["Work", "Personal"]
    );
    assert_eq!(listed.iter().filter(|v| v.active()).count(), 1);
    assert!(!listed[0].active());
    assert!(listed[1].active());
    service
        .update(work.id().clone(), Some("Office".into()), None, 3)
        .await
        .unwrap();
    service
        .update(work.id().clone(), None, Some(key("fixture-secret-a")), 4)
        .await
        .unwrap();
    assert_eq!(service.get(work.id()).unwrap().unwrap().generation(), 0);
    service
        .update(work.id().clone(), None, Some(key("fixture-secret-c")), 5)
        .await
        .unwrap();
    let changed = service.get(work.id()).unwrap().unwrap();
    assert_eq!((changed.generation(), changed.account_generation()), (1, 1));
    let replaced = service
        .create(
            "unused".into(),
            "openai".into(),
            Some("Office".into()),
            key("fixture-secret-c"),
            6,
        )
        .await
        .unwrap();
    assert_eq!(replaced.id(), work.id());
    assert_eq!(
        (replaced.generation(), replaced.account_generation()),
        (1, 2)
    );
    assert_eq!(service.all().unwrap().len(), 2);
    for text in [
        format!("{replaced:?}"),
        format!("{replaced}"),
        format!("{:?}", replaced.secret()),
        format!("{}", replaced.secret()),
    ] {
        for secret in ["fixture-secret", "fixture-id", "unused"] {
            assert!(!text.contains(secret), "{text}");
        }
    }
    service.activate(personal.id().clone(), 7).await.unwrap();
    service.remove(personal.id().clone(), 8).await.unwrap();
    assert!(service.get(work.id()).unwrap().unwrap().active());
    service.remove(work.id().clone(), 9).await.unwrap();
    assert!(service.list(&"openai".into()).unwrap().is_empty());
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn explicit_binding_isolates_accounts_and_requires_reselection_after_replacement() {
    let store = store();
    let service = Service::new(store.client());
    let work = service
        .create(
            "a".into(),
            "openai".into(),
            Some("Work".into()),
            key("work"),
            1,
        )
        .await
        .unwrap();
    service
        .create(
            "b".into(),
            "openai".into(),
            Some("Personal".into()),
            key("personal"),
            2,
        )
        .await
        .unwrap();
    let binding = service
        .bind("provider".into(), "openai".into(), "Work".into())
        .unwrap();
    assert_eq!(service.resolve_binding(&binding).unwrap().id(), work.id());
    let unrelated = service.bind("provider".into(), "other".into(), "Work".into());
    assert_eq!(unrelated.unwrap_err(), Error::ProfileUnavailable);
    service
        .create(
            "c".into(),
            "openai".into(),
            Some("Work".into()),
            key("replacement"),
            3,
        )
        .await
        .unwrap();
    assert_eq!(
        service.resolve_binding(&binding).unwrap_err(),
        Error::ProfileUnavailable
    );
    let selected = service
        .bind("provider".into(), "openai".into(), "Work".into())
        .unwrap();
    assert_eq!(
        service
            .resolve_binding(&selected)
            .unwrap()
            .account_generation(),
        1
    );
    service.remove(work.id().clone(), 4).await.unwrap();
    assert_eq!(
        service.resolve_binding(&selected).unwrap_err(),
        Error::ProfileUnavailable
    );
    assert!(service.active(&"openai".into()).unwrap().is_some());
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn refresh_preserves_binding_fences_stale_accounts_and_adopts_only_fresh_rotations() {
    let store = store();
    let service = Service::new(store.client());
    let old = service
        .create("a".into(), "openai".into(), None, oauth("old", 0), 1)
        .await
        .unwrap();
    let binding = service
        .bind("openai".into(), "openai".into(), "default".into())
        .unwrap();
    let next = service
        .refresh(old.clone(), 2, async { Ok(oauth("new", 600_000)) })
        .await
        .unwrap()
        .unwrap();
    assert_eq!((next.generation(), next.account_generation()), (1, 0));
    assert_eq!(service.resolve_binding(&binding).unwrap(), next);
    assert_eq!(
        service
            .refresh(old.clone(), 3, async {
                panic!("must not reuse rotated token")
            })
            .await
            .unwrap(),
        Some(next)
    );
    service
        .create(
            "unused".into(),
            "openai".into(),
            None,
            oauth("replacement", 600_000),
            4,
        )
        .await
        .unwrap();
    assert!(
        service
            .refresh(old, 5, async {
                panic!("must not refresh replaced account")
            })
            .await
            .unwrap()
            .is_none()
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn concurrent_refresh_is_shared_and_unknown_outcome_cannot_replay() {
    let store = store();
    let service = Service::new(store.client());
    let old = service
        .create("a".into(), "openai".into(), None, oauth("old", 0), 1)
        .await
        .unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let first_service = service.clone();
    let first_old = old.clone();
    let first = tokio::spawn(async move {
        first_service
            .refresh(first_old, 2, async move {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Err(Error::UnknownOutcome)
            })
            .await
    });
    entered_rx.await.unwrap();
    let second = service.refresh(old.clone(), 2, async { panic!("duplicate refresh") });
    let release = async {
        release_tx.send(()).unwrap();
    };
    let (second, ()) = tokio::join!(second, release);
    assert_eq!(first.await.unwrap(), Err(Error::UnknownOutcome));
    assert_eq!(second, Err(Error::UnknownOutcome));
    assert_eq!(
        service
            .refresh(old.clone(), 3, async { panic!("unknown outcome replay") })
            .await,
        Err(Error::UnknownOutcome)
    );
    assert_eq!(service.get(old.id()).unwrap().unwrap(), old);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn refresh_adopts_other_process_rotation_after_rejection_but_not_expiry_or_replacement() {
    for (expires, replacement, adopt) in [
        (600_000, false, true),
        (0, false, false),
        (600_000, true, false),
    ] {
        let store = store();
        let service = Service::new(store.client());
        let old = service
            .create("a".into(), "openai".into(), None, oauth("old", 0), 1)
            .await
            .unwrap();
        let writer = store.client();
        let current_id = old.id().clone();
        let result = service
            .refresh(old.clone(), 2, async move {
                writer
                    .submit(move |tx| {
                        use ycoding_store::TableSpec;
                        let identity = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(
                            &current_id,
                        )]);
                        let mut row = tx.get::<resources::CredentialTable>(&identity)?.unwrap();
                        row.value = oauth("other-process", expires);
                        row.generation += 1;
                        row.account_generation += i64::from(replacement);
                        tx.put::<resources::CredentialTable>(&row)?;
                        assert_eq!(resources::CredentialTable::primary_key(&row), identity);
                        Ok(())
                    })
                    .unwrap()
                    .await
                    .unwrap();
                Err(Error::Rejected)
            })
            .await;
        if adopt {
            assert_eq!(result.unwrap().unwrap().generation(), 1);
        } else {
            assert_eq!(result, Err(Error::Rejected));
        }
        assert_eq!(service.get(old.id()).unwrap().unwrap().generation(), 1);
        service.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn blocked_refresh_does_not_block_other_profiles_and_cannot_overwrite_replacement() {
    let store = store();
    let service = Service::new(store.client());
    let work = service
        .create(
            "a".into(),
            "test".into(),
            Some("Work".into()),
            oauth("old", 0),
            1,
        )
        .await
        .unwrap();
    let personal = service
        .create(
            "b".into(),
            "test".into(),
            Some("Personal".into()),
            oauth("old", 0),
            2,
        )
        .await
        .unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let first_service = service.clone();
    let old = work.clone();
    let first = tokio::spawn(async move {
        first_service
            .refresh(old, 3, async move {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(oauth("late", 600_000))
            })
            .await
    });
    entered_rx.await.unwrap();
    assert_eq!(
        service
            .refresh(personal, 3, async { Ok(oauth("personal", 600_000)) })
            .await
            .unwrap()
            .unwrap()
            .generation(),
        1
    );
    service
        .create(
            "unused".into(),
            "test".into(),
            Some("Work".into()),
            oauth("replacement", 600_000),
            4,
        )
        .await
        .unwrap();
    release_tx.send(()).unwrap();
    assert!(first.await.unwrap().unwrap().is_none());
    assert_eq!(
        service
            .get(work.id())
            .unwrap()
            .unwrap()
            .account_generation(),
        1
    );
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn duplicate_profile_names_fail_binding_and_cross_provider_selection_is_rejected() {
    let store = store();
    let service = Service::new(store.client());
    let first = service
        .create(
            "a".into(),
            "test".into(),
            Some("Work".into()),
            key("one"),
            1,
        )
        .await
        .unwrap();
    let second = service
        .create(
            "b".into(),
            "test".into(),
            Some("Personal".into()),
            key("two"),
            2,
        )
        .await
        .unwrap();
    let binding = service
        .bind("provider-a".into(), "test".into(), "Work".into())
        .unwrap();
    assert_eq!(
        service
            .resolve_selection(
                &"provider-b".into(),
                &"test".into(),
                &"Work".into(),
                &binding
            )
            .unwrap_err(),
        Error::ProfileUnavailable
    );
    service
        .update(second.id().clone(), Some("Work".into()), None, 3)
        .await
        .unwrap();
    assert_eq!(
        service.resolve_binding(&binding).unwrap_err(),
        Error::ProfileUnavailable
    );
    assert_eq!(
        service
            .bind("provider-a".into(), "test".into(), "Work".into())
            .unwrap_err(),
        Error::ProfileUnavailable
    );
    assert_eq!(service.get(first.id()).unwrap().unwrap().generation(), 0);
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn missing_or_empty_integration_rows_are_not_resolved_as_connections() {
    let store = store();
    let service = Service::new(store.client());
    let created = service
        .create("empty".into(), "".into(), None, key("secret"), 1)
        .await
        .unwrap();
    assert!(service.get(created.id()).unwrap().is_none());
    assert!(service.all().unwrap().is_empty());
    assert!(service.list(&"".into()).unwrap().is_empty());
    assert!(service.active(&"".into()).unwrap().is_none());
    service.activate(created.id().clone(), 2).await.unwrap();
    service.remove(created.id().clone(), 3).await.unwrap();
    service.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_refresh_waiter_does_not_cancel_shared_token_exchange() {
    let store = store();
    let service = Service::new(store.client());
    let old = service
        .create("a".into(), "test".into(), None, oauth("old", 0), 1)
        .await
        .unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let caller_service = service.clone();
    let expected = old.clone();
    let caller = tokio::spawn(async move {
        caller_service
            .refresh(expected, 2, async move {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Ok(oauth("new", 600_000))
            })
            .await
    });
    entered_rx.await.unwrap();
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    let observer = service.refresh(old.clone(), 2, async {
        panic!("must join surviving refresh")
    });
    let release = async {
        release_tx.send(()).unwrap();
    };
    let (result, ()) = tokio::join!(observer, release);
    assert_eq!(result.unwrap().unwrap().generation(), 1);
    service.shutdown().await.unwrap();
    assert_eq!(
        service
            .refresh(old, 3, async { panic!("closed service") })
            .await
            .unwrap_err(),
        Error::Closed
    );
}

#[tokio::test]
async fn service_shutdown_cancels_and_joins_inflight_refresh_without_replay() {
    let store = store();
    let service = Service::new(store.client());
    let old = service
        .create("a".into(), "test".into(), None, oauth("old", 0), 1)
        .await
        .unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let caller_service = service.clone();
    let expected = old.clone();
    let caller = tokio::spawn(async move {
        caller_service
            .refresh(expected, 2, async move {
                entered_tx.send(()).unwrap();
                release_rx.await.unwrap();
                Err(Error::Rejected)
            })
            .await
    });
    entered_rx.await.unwrap();
    let shutdown =
        tokio::time::timeout(std::time::Duration::from_secs(2), service.shutdown()).await;
    let _ = release_tx.send(());
    let result = caller.await.unwrap();
    assert!(
        shutdown.is_ok(),
        "shutdown waited indefinitely for token endpoint"
    );
    shutdown.unwrap().unwrap();
    assert_eq!(result, Err(Error::UnknownOutcome));
    assert_eq!(service.get(old.id()).unwrap().unwrap(), old);
}
