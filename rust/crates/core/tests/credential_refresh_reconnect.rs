use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};
use ycoding_core::resources::{
    auth::integration::{Authorization, OAuthImplementation, Registry},
    credential::{Error, Info, Service},
};
use ycoding_schema::{
    DomainEncode, LosslessString, connection, credential, integration,
    integration_id::IntegrationMethodId, schema::NonNegativeInt,
};
use ycoding_store::{Catalog, Metadata, Options, Store, resources};

const FUTURE: i64 = 9_000_000_000_000;

fn store() -> Store {
    Store::disposable(
        Options::core(),
        Catalog::new(1, resources::TABLES),
        Metadata::new([9; 16], 1),
    )
    .unwrap()
}

fn oauth(access: &str, refresh: &str, expires: i64) -> resources::Secret {
    resources::Secret::new(
        credential::Value::OAuth(credential::OAuth {
            method_id: IntegrationMethodId::new("browser").unwrap(),
            access: access.into(),
            refresh: refresh.into(),
            expires: NonNegativeInt::new(expires).unwrap(),
            metadata: None,
        })
        .encode(),
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

fn oauth_value(info: &Info) -> credential::OAuth {
    let credential::Value::OAuth(value) = info.secret().domain().unwrap() else {
        panic!("expected an OAuth credential")
    };
    value
}

#[derive(Default)]
struct Endpoint {
    refreshes: Mutex<Vec<String>>,
    authorizations: AtomicUsize,
    reject_refresh: AtomicBool,
}

struct Harness {
    store: Store,
    service: Service,
    registry: Registry,
    endpoint: Arc<Endpoint>,
    _registration: ycoding_core::resources::auth::integration::Registration,
}

impl Harness {
    async fn finish(self) {
        self._registration.dispose().unwrap();
        self.registry.shutdown().await.unwrap();
        self.service.shutdown().await.unwrap();
        self.store.shutdown().unwrap();
    }

    async fn profile(&self, label: &str, secret: resources::Secret) -> Info {
        self.service
            .create(
                format!("cred_{label}").into(),
                "acme".into(),
                Some(label.into()),
                secret,
                1,
            )
            .await
            .unwrap()
    }

    fn connections(&self, integration: &str) -> Vec<connection::Info> {
        self.registry
            .get(&integration.into())
            .unwrap()
            .unwrap()
            .connections
    }
}

fn harness() -> Harness {
    let store = store();
    let service = Service::new(store.client());
    let env = BTreeMap::from([("SYNTHETIC_KEYONLY_API_KEY".into(), "sk-env".into())]);
    let registry = Registry::new(service.clone(), env);
    let endpoint = Arc::new(Endpoint::default());
    let exchange = endpoint.clone();
    let authorize = endpoint.clone();
    let registration = registry
        .transform(move |draft| {
            let exchange = exchange.clone();
            let authorize = authorize.clone();
            draft.update("acme".into(), |item| item.name = "Acme".into());
            draft.update("other".into(), |item| item.name = "Other".into());
            draft.update("keyonly".into(), |item| item.name = "Key Only".into());
            draft.method(
                "acme".into(),
                integration::Method::Key(integration::KeyMethod { label: None }),
            );
            draft.method(
                "other".into(),
                integration::Method::Key(integration::KeyMethod { label: None }),
            );
            draft.method(
                "keyonly".into(),
                integration::Method::Env(integration::EnvMethod {
                    names: vec!["SYNTHETIC_KEYONLY_API_KEY".into()],
                }),
            );
            draft.oauth(OAuthImplementation {
                integration: "acme".into(),
                method: integration::OAuthMethod {
                    id: IntegrationMethodId::new("browser").unwrap(),
                    label: "Browser".into(),
                    prompts: None,
                    remote: Some(true),
                },
                authorize: Arc::new(move |_| {
                    let authorize = authorize.clone();
                    Box::pin(async move {
                        authorize.authorizations.fetch_add(1, Ordering::SeqCst);
                        Ok(Authorization::code(
                            "https://auth.synthetic.test/authorize".into(),
                            "Paste the code".into(),
                            Arc::new(|code| {
                                Box::pin(async move {
                                    if code == "good" {
                                        Ok(oauth("at-new", "rt-new", FUTURE))
                                    } else {
                                        Err(Error::Rejected)
                                    }
                                })
                            }),
                        ))
                    })
                }),
                refresh: Some(Arc::new(move |value| {
                    let exchange = exchange.clone();
                    Box::pin(async move {
                        exchange
                            .refreshes
                            .lock()
                            .unwrap()
                            .push(value.refresh.to_utf8().unwrap());
                        if exchange.reject_refresh.load(Ordering::SeqCst) {
                            return Err(Error::Rejected);
                        }
                        Ok(oauth("at-2", "rt-2", FUTURE))
                    })
                })),
                label: None,
            });
            draft.oauth(OAuthImplementation {
                integration: "other".into(),
                method: integration::OAuthMethod {
                    id: IntegrationMethodId::new("browser").unwrap(),
                    label: "Browser".into(),
                    prompts: None,
                    remote: Some(true),
                },
                authorize: Arc::new(|_| Box::pin(async { Err(Error::Rejected) })),
                refresh: None,
                label: None,
            });
        })
        .unwrap();
    Harness {
        store,
        service,
        registry,
        endpoint,
        _registration: registration,
    }
}

fn credential_info(connection: &connection::Info) -> &connection::CredentialInfo {
    let connection::Info::Credential(info) = connection else {
        panic!("expected a credential connection")
    };
    info
}

fn inputs() -> integration::Inputs {
    integration::Inputs(ycoding_schema::JsonObject::new())
}

#[tokio::test]
async fn refresh_rotates_the_stored_tokens_and_reports_the_new_expiry() {
    let harness = harness();
    let work = harness
        .profile("work", oauth("at-1", "rt-1", FUTURE - 1))
        .await;

    let result = harness.registry.refresh(work.id(), 2_000).await.unwrap();

    assert_eq!(
        result,
        integration::RefreshResult::Refreshed {
            expires: NonNegativeInt::new(FUTURE).unwrap()
        }
    );
    assert_eq!(*harness.endpoint.refreshes.lock().unwrap(), vec!["rt-1"]);
    let stored = harness.service.get(work.id()).unwrap().unwrap();
    let value = oauth_value(&stored);
    assert_eq!(value.access.to_utf8().unwrap(), "at-2");
    assert_eq!(value.refresh.to_utf8().unwrap(), "rt-2");
    assert_eq!(stored.account_generation(), work.account_generation());
    let connections = harness.connections("acme");
    assert_eq!(connections.len(), 1);
    let listed = credential_info(&connections[0]);
    assert_eq!(listed.label, "work".into());
    assert_eq!(listed.kind, Some(connection::CredentialKind::Oauth));
    assert_eq!(listed.status, Some(connection::CredentialStatus::Connected));
    assert_eq!(listed.message, None);
    harness.finish().await;
}

#[tokio::test]
async fn failed_refresh_reports_the_failure_projects_refresh_failed_and_recovers_on_success() {
    let harness = harness();
    let work = harness.profile("work", oauth("at-1", "rt-1", FUTURE)).await;
    harness
        .endpoint
        .reject_refresh
        .store(true, Ordering::SeqCst);

    let failed = harness.registry.refresh(work.id(), 2_000).await.unwrap();

    let integration::RefreshResult::Failed { message } = failed else {
        panic!("expected a failed refresh")
    };
    assert_eq!(message, Error::Rejected.to_string().into());
    assert!(harness.service.get(work.id()).unwrap().unwrap() == work);
    let connections = harness.connections("acme");
    let listed = credential_info(&connections[0]);
    assert_eq!(
        listed.status,
        Some(connection::CredentialStatus::RefreshFailed)
    );
    assert_eq!(listed.message, Some(message));

    harness
        .endpoint
        .reject_refresh
        .store(false, Ordering::SeqCst);
    assert!(matches!(
        harness.registry.refresh(work.id(), 3_000).await.unwrap(),
        integration::RefreshResult::Refreshed { .. }
    ));
    let connections = harness.connections("acme");
    let listed = credential_info(&connections[0]);
    assert_eq!(listed.status, Some(connection::CredentialStatus::Connected));
    assert_eq!(listed.message, None);
    assert_eq!(harness.endpoint.refreshes.lock().unwrap().len(), 2);
    harness.finish().await;
}

#[tokio::test]
async fn refresh_refuses_keys_unknown_profiles_and_sign_ins_without_a_refresh_method() {
    let harness = harness();
    let api = harness.profile("api", key("sk-synthetic")).await;
    let foreign = harness
        .service
        .create(
            "cred_foreign".into(),
            "other".into(),
            Some("foreign".into()),
            oauth("at-f", "rt-f", FUTURE),
            1,
        )
        .await
        .unwrap();

    let key_result = harness.registry.refresh(api.id(), 2_000).await.unwrap();
    let unknown = harness
        .registry
        .refresh(&"cred_missing".into(), 2_000)
        .await
        .unwrap();
    let unsupported = harness.registry.refresh(foreign.id(), 2_000).await.unwrap();

    assert_eq!(
        key_result,
        integration::RefreshResult::Failed {
            message: "API keys do not refresh; replace the key instead".into()
        }
    );
    assert_eq!(
        unknown,
        integration::RefreshResult::Failed {
            message: "Credential not found: cred_missing".into()
        }
    );
    assert_eq!(
        unsupported,
        integration::RefreshResult::Failed {
            message: "Other sign-in cannot be refreshed; reconnect instead".into()
        }
    );
    assert!(harness.endpoint.refreshes.lock().unwrap().is_empty());
    assert!(harness.service.get(api.id()).unwrap().unwrap() == api);
    harness.finish().await;
}

#[tokio::test]
async fn reconnect_replaces_only_the_targeted_profile_in_place_after_success() {
    let harness = harness();
    let work = harness.profile("work", oauth("at-1", "rt-1", FUTURE)).await;
    let personal = harness
        .profile("personal", oauth("at-p", "rt-p", FUTURE))
        .await;

    let attempt = harness
        .registry
        .reconnect(
            "acme".into(),
            "browser".into(),
            inputs(),
            work.id().clone(),
            10,
        )
        .await
        .unwrap();
    harness
        .registry
        .complete(&"acme".into(), &attempt.attempt_id, Some("good"), 11)
        .await
        .unwrap();

    assert!(matches!(
        harness
            .registry
            .status(&"acme".into(), &attempt.attempt_id)
            .unwrap(),
        integration::AttemptStatus::Complete(_)
    ));
    let profiles = harness.service.list(&"acme".into()).unwrap();
    assert_eq!(profiles.len(), 2);
    let replaced = harness.service.get(work.id()).unwrap().unwrap();
    assert_eq!(replaced.label(), &"work".into());
    assert!(replaced.active());
    assert_eq!(oauth_value(&replaced).access.to_utf8().unwrap(), "at-new");
    assert_eq!(oauth_value(&replaced).refresh.to_utf8().unwrap(), "rt-new");
    let other = harness.service.get(personal.id()).unwrap().unwrap();
    assert!(!other.active());
    assert_eq!(oauth_value(&other).access.to_utf8().unwrap(), "at-p");
    harness.finish().await;
}

#[tokio::test]
async fn cancelled_or_failed_reconnect_keeps_the_existing_credential() {
    let harness = harness();
    let work = harness.profile("work", oauth("at-1", "rt-1", FUTURE)).await;

    let cancelled = harness
        .registry
        .reconnect(
            "acme".into(),
            "browser".into(),
            inputs(),
            work.id().clone(),
            10,
        )
        .await
        .unwrap();
    harness
        .registry
        .cancel(&"acme".into(), &cancelled.attempt_id)
        .await
        .unwrap();
    let rejected = harness
        .registry
        .reconnect(
            "acme".into(),
            "browser".into(),
            inputs(),
            work.id().clone(),
            20,
        )
        .await
        .unwrap();
    let outcome = harness
        .registry
        .complete(&"acme".into(), &rejected.attempt_id, Some("bad"), 21)
        .await;

    assert_eq!(outcome, Err(Error::Rejected));
    assert!(matches!(
        harness
            .registry
            .status(&"acme".into(), &rejected.attempt_id)
            .unwrap(),
        integration::AttemptStatus::Failed { .. }
    ));
    let profiles = harness.service.list(&"acme".into()).unwrap();
    assert_eq!(profiles.len(), 1);
    assert!(profiles[0] == work);
    harness.finish().await;
}

#[tokio::test]
async fn reconnect_and_key_replacement_reject_unknown_or_foreign_targets_without_side_effects() {
    let harness = harness();
    harness.profile("work", oauth("at-1", "rt-1", FUTURE)).await;
    let foreign = harness
        .service
        .create(
            "cred_foreign".into(),
            "other".into(),
            Some("foreign".into()),
            key("sk-foreign"),
            1,
        )
        .await
        .unwrap();
    let before = harness.service.all().unwrap();

    let results = [
        harness
            .registry
            .reconnect(
                "acme".into(),
                "browser".into(),
                inputs(),
                foreign.id().clone(),
                10,
            )
            .await
            .map(|_| ()),
        harness
            .registry
            .reconnect(
                "acme".into(),
                "browser".into(),
                inputs(),
                "cred_missing".into(),
                10,
            )
            .await
            .map(|_| ()),
        harness
            .registry
            .replace_key("acme".into(), foreign.id().clone(), "sk-new".into(), 10)
            .await,
        harness
            .registry
            .replace_key("acme".into(), "cred_missing".into(), "sk-new".into(), 10)
            .await,
    ];

    assert_eq!(results, [Err(Error::Rejected); 4]);
    assert_eq!(harness.endpoint.authorizations.load(Ordering::SeqCst), 0);
    assert!(harness.service.all().unwrap() == before);
    harness.finish().await;
}

#[tokio::test]
async fn replacing_a_key_keeps_the_profile_identity_and_converts_a_failed_sign_in_to_connected() {
    let harness = harness();
    let work = harness.profile("work", oauth("at-1", "rt-1", FUTURE)).await;
    harness
        .endpoint
        .reject_refresh
        .store(true, Ordering::SeqCst);
    harness.registry.refresh(work.id(), 2_000).await.unwrap();

    harness
        .registry
        .replace_key(
            "acme".into(),
            work.id().clone(),
            "sk-synthetic-new".into(),
            10,
        )
        .await
        .unwrap();

    let profiles = harness.service.list(&"acme".into()).unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].id(), work.id());
    assert_eq!(profiles[0].label(), &"work".into());
    assert_eq!(
        profiles[0].secret().domain().unwrap(),
        credential::Value::Key(credential::Key {
            key: "sk-synthetic-new".into(),
            metadata: None,
        })
    );
    let connections = harness.connections("acme");
    let listed = credential_info(&connections[0]);
    assert_eq!(listed.kind, Some(connection::CredentialKind::Key));
    assert_eq!(listed.status, Some(connection::CredentialStatus::Connected));
    assert_eq!(listed.message, None);
    assert!(!format!("{listed:?}").contains("sk-synthetic-new"));
    harness.finish().await;
}

#[tokio::test]
async fn connections_report_expired_oauth_and_leave_env_and_unconnected_integrations_statusless() {
    let harness = harness();
    let stale = harness
        .profile("stale", oauth("at-old", "rt-old", 1_000))
        .await;

    let acme = harness.connections("acme");
    let keyonly = harness.connections("keyonly");
    let other = harness.connections("other");

    assert_eq!(acme.len(), 1);
    let listed = credential_info(&acme[0]);
    assert_eq!(listed.id, credential::Id(stale.id().clone()));
    assert_eq!(listed.status, Some(connection::CredentialStatus::Expired));
    assert_eq!(listed.message, None);
    assert_eq!(
        keyonly,
        vec![connection::Info::Env(connection::EnvInfo {
            name: LosslessString::from("SYNTHETIC_KEYONLY_API_KEY")
        })]
    );
    assert!(other.is_empty());
    harness.finish().await;
}
