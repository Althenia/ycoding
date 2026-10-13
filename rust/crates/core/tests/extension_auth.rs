include!("tool_fixture.rs");
use std::{collections::BTreeMap, time::Duration};
use ycoding_core::extension::{
    Configuration, Error, Extension, FamilyGrant, Host, Options, ToolGrant, v5, wire,
};
use ycoding_core::resources::{
    auth::integration::{Event, Registry},
    credential::{Error as CredentialError, Service},
};
use ycoding_schema::{
    DomainEncode, JsonObject, credential, integration, integration_id::IntegrationMethodId,
    parse_json, schema::NonNegativeInt,
};
use ycoding_store::{Catalog, Metadata, Store, resources};

struct Auth {
    store: Store,
    service: Service,
    registry: Registry,
}
impl Auth {
    fn new() -> Self {
        let store = Store::disposable(
            ycoding_store::Options::core(),
            Catalog::new(1, resources::TABLES),
            Metadata::new([8; 16], 1),
        )
        .unwrap();
        let service = Service::new(store.client());
        let registry = Registry::new(service.clone(), BTreeMap::new());
        Self {
            store,
            service,
            registry,
        }
    }
    fn host(&self) -> Host {
        Host {
            integrations: Some(self.registry.clone()),
            ..Host::default()
        }
    }
    async fn shutdown(self) {
        self.registry.shutdown().await.unwrap();
        self.service.shutdown().await.unwrap();
        self.store.shutdown().unwrap();
    }
}
fn configuration(fixture: &ToolFixture, mode: &str) -> Configuration {
    Configuration {
        identity: "fixture".into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            mode.into(),
        ],
        directory: fixture.root.clone(),
        registration_order: 0,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: vec![FamilyGrant {
            family: v5::CapabilityFamily::Auth,
            scopes: vec!["acme".into()],
            action: "extension.auth".into(),
            resources: vec!["acme".into()],
        }],
    }
}
async fn start(fixture: &ToolFixture, mode: &str, host: Host) -> Result<Extension, Error> {
    start_with(fixture, mode, host, Duration::from_secs(10)).await
}
async fn start_with(
    fixture: &ToolFixture,
    mode: &str,
    host: Host,
    execution: Duration,
) -> Result<Extension, Error> {
    Extension::start(
        configuration(fixture, mode),
        Options {
            startup: Duration::from_secs(1),
            execution,
            cleanup: Duration::from_millis(100),
            shutdown: Duration::from_millis(100),
            write: Duration::from_millis(500),
        },
        &fixture.registry(),
        fixture.policy.clone(),
        &fixture.context(),
        host,
    )
    .await
}
async fn connect(auth: &Auth, time: i64) -> Result<integration::Attempt, CredentialError> {
    auth.registry
        .connect(
            "acme".into(),
            "acme-login".into(),
            integration::Inputs(JsonObject::new()),
            None,
            time,
        )
        .await
}
async fn connected(events: &mut tokio::sync::broadcast::Receiver<Event>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while events.recv().await.unwrap() != Event::ConnectionUpdated("acme".into()) {}
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn code_method_authorizes_exchanges_labels_and_persists_through_the_registry() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    let extension = start(&fixture, "auth_code", auth.host()).await.unwrap();
    let info = auth.registry.get(&"acme".into()).unwrap().unwrap();
    assert!(matches!(
        &info.methods[0],
        integration::Method::OAuth(method) if method.id.as_lossless() == &"acme-login".into()
    ));
    let rejected = connect(&auth, 0).await.unwrap();
    assert_eq!(rejected.mode, "code".into());
    assert_eq!(
        auth.registry
            .complete(&"acme".into(), &rejected.attempt_id, Some("wrong"), 1)
            .await
            .unwrap_err(),
        CredentialError::Rejected
    );
    assert!(auth.service.list(&"acme".into()).unwrap().is_empty());
    let attempt = connect(&auth, 2).await.unwrap();
    auth.registry
        .complete(&"acme".into(), &attempt.attempt_id, Some("good-code"), 3)
        .await
        .unwrap();
    assert!(matches!(
        auth.registry
            .status(&"acme".into(), &attempt.attempt_id)
            .unwrap(),
        integration::AttemptStatus::Complete(_)
    ));
    let stored = auth.service.list(&"acme".into()).unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].label(), &"acme-user".into());
    extension.shutdown().await;
    fixture.cleanup();
    auth.shutdown().await;
}

#[tokio::test]
async fn automatic_method_completes_from_the_child_callback_and_accepts_a_manual_code() {
    for (mode, manual) in [("auth_auto", false), ("auth_auto_pending", true)] {
        let fixture = ToolFixture::new();
        let auth = Auth::new();
        let extension = start(&fixture, mode, auth.host()).await.unwrap();
        let mut events = auth.registry.subscribe();
        let attempt = connect(&auth, 0).await.unwrap();
        assert_eq!(attempt.mode, "auto".into(), "{mode}");
        assert_eq!(attempt.manual_code, manual.then_some(true), "{mode}");
        if manual {
            auth.registry
                .complete(&"acme".into(), &attempt.attempt_id, Some("manual"), 1)
                .await
                .unwrap();
        }
        connected(&mut events).await;
        let stored = auth.service.list(&"acme".into()).unwrap();
        assert_eq!(stored[0].label(), &"acme-user".into(), "{mode}");
        extension.shutdown().await;
        fixture.cleanup();
        auth.shutdown().await;
    }
}

#[tokio::test]
async fn expired_credentials_refresh_through_the_child() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    let extension = start(&fixture, "auth_auto", auth.host()).await.unwrap();
    auth.service
        .create(
            "stale".into(),
            "acme".into(),
            Some("Acme".into()),
            resources::Secret::new(
                credential::Value::OAuth(credential::OAuth {
                    method_id: IntegrationMethodId::new("acme-login").unwrap(),
                    access: "stale-access".into(),
                    refresh: "refresh-token".into(),
                    expires: NonNegativeInt::new(10).unwrap(),
                    metadata: None,
                })
                .encode(),
            )
            .unwrap(),
            1,
        )
        .await
        .unwrap();
    let connection = auth
        .registry
        .get(&"acme".into())
        .unwrap()
        .unwrap()
        .connections
        .remove(0);
    let snapshot = auth.registry.snapshot(connection, 1_000_000).await.unwrap();
    assert!(matches!(
        snapshot.value.unwrap().domain().unwrap(),
        credential::Value::OAuth(value) if value.access == "refreshed-access".into()
    ));
    extension.shutdown().await;
    fixture.cleanup();
    auth.shutdown().await;
}

#[tokio::test]
async fn ungranted_or_unhosted_registrations_fail_before_any_method_is_installed() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    assert_eq!(
        start(&fixture, "auth_ungranted", auth.host()).await.err(),
        Some(Error::Unauthorized)
    );
    assert_eq!(
        start(&fixture, "auth_code", Host::default()).await.err(),
        Some(Error::Unauthorized)
    );
    assert!(auth.registry.get(&"other".into()).unwrap().is_none());
    assert!(auth.registry.get(&"acme".into()).unwrap().is_none());
    fixture.cleanup();
    auth.shutdown().await;
}

#[tokio::test]
async fn mismatched_or_unsolicited_replies_close_and_revoke_the_generation() {
    for mode in ["auth_wrong_kind", "auth_unknown_reply"] {
        let fixture = ToolFixture::new();
        let auth = Auth::new();
        let extension = start(&fixture, mode, auth.host()).await.unwrap();
        if mode == "auth_wrong_kind" {
            assert_eq!(
                connect(&auth, 0).await.unwrap_err(),
                CredentialError::UnknownOutcome,
                "the pending request fails visibly"
            );
        }
        tokio::time::timeout(Duration::from_secs(3), extension.closed())
            .await
            .unwrap_or_else(|_| panic!("{mode}: the generation must close"));
        assert_eq!(
            extension.diagnostics().last(),
            Some(&v5::DiagnosticCode::ProtocolRejected),
            "{mode}"
        );
        assert!(
            auth.registry.get(&"acme".into()).unwrap().is_none(),
            "{mode}"
        );
        assert_eq!(
            connect(&auth, 1).await.unwrap_err(),
            CredentialError::Rejected,
            "{mode}"
        );
        extension.shutdown().await;
        fixture.cleanup();
        auth.shutdown().await;
    }
}

#[tokio::test]
async fn silent_children_close_the_generation_at_the_execution_deadline() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    let extension = start_with(
        &fixture,
        "auth_silent",
        auth.host(),
        Duration::from_millis(300),
    )
    .await
    .unwrap();
    assert_eq!(
        connect(&auth, 0).await.unwrap_err(),
        CredentialError::UnknownOutcome
    );
    tokio::time::timeout(Duration::from_secs(3), extension.closed())
        .await
        .unwrap();
    assert_eq!(
        extension.diagnostics().last(),
        Some(&v5::DiagnosticCode::DeadlineExceeded)
    );
    assert!(auth.registry.get(&"acme".into()).unwrap().is_none());
    extension.shutdown().await;
    fixture.cleanup();
    auth.shutdown().await;
}

#[test]
fn credential_bearing_messages_never_render_their_secrets() {
    let secret = parse_json(r#"{"access":"SECRET-ACCESS","refresh":"SECRET-REFRESH"}"#).unwrap();
    let code = wire::text(&"SECRET-CODE".into());
    let reply = v5::AuthReply {
        request: 1,
        outcome: Some(v5::auth_reply::Outcome::Credential(wire::value(&secret))),
    };
    let rendered = [
        format!("{reply:?}"),
        format!(
            "{:?}",
            v5::ChildFrame {
                generation: "g".into(),
                body: Some(v5::child_frame::Body::AuthReply(reply)),
            }
        ),
        format!(
            "{:?}",
            v5::HostFrame {
                generation: "g".into(),
                body: Some(v5::host_frame::Body::Auth(v5::AuthRequest {
                    request: 2,
                    operation: Some(v5::auth_request::Operation::Refresh(v5::AuthRefresh {
                        integration: "acme".into(),
                        method: "acme-login".into(),
                        credential: wire::value(&secret),
                    })),
                })),
            }
        ),
        format!(
            "{:?}",
            v5::AuthLabel {
                integration: "acme".into(),
                method: "acme-login".into(),
                credential: wire::value(&secret),
            }
        ),
        format!(
            "{:?}",
            v5::AuthCallback {
                authorization: 3,
                code: Some(code.clone()),
            }
        ),
        format!(
            "{:?}",
            v5::AuthSubmit {
                authorization: 3,
                code,
            }
        ),
    ];
    for text in rendered {
        assert!(!text.contains("SECRET"), "{text}");
    }
}
