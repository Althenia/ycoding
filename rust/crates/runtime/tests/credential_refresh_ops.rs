mod support;

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use support::{
    wire::{ask, location_scope, query, refuse},
    *,
};
use ycoding_core::resources::{
    auth::integration::{Authorization, OAuthImplementation, Registration, Registry},
    credential,
};
use ycoding_core::ycoding_schema::{
    DomainEncode, credential as credential_schema, integration, schema::NonNegativeInt,
};
use ycoding_core::ycoding_store::{Catalog, Metadata, Options, Store, resources};
use ycoding_protocol::v5;
use ycoding_runtime::{IntegrationServices, LocalAuth, Server, standard};

const DIRECTORY: &str = "/project/credential-refresh-wire";
const FUTURE: i64 = 9_000_000_000_000;

fn locations_ready() {
    static READY: OnceLock<()> = OnceLock::new();
    READY.get_or_init(|| {
        world()
            .store
            .submit(|tx| {
                ycoding_core::ycoding_store::project::ProjectTable::insert(
                    tx,
                    &ycoding_core::ycoding_store::project::Project {
                        id: "prj_credential_refresh_wire".into(),
                        worktree: DIRECTORY.into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
    });
}

fn secret(access: &str, refresh: &str) -> resources::Secret {
    resources::Secret::new(
        credential_schema::Value::OAuth(credential_schema::OAuth {
            method_id: integration::MethodId::new("browser").unwrap(),
            access: access.into(),
            refresh: refresh.into(),
            expires: NonNegativeInt::new(FUTURE).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

struct Fixture {
    store: Store,
    credentials: credential::Service,
    registry: Registry,
    registration: Registration,
    refreshes: Arc<Mutex<Vec<String>>>,
    reject: Arc<AtomicBool>,
}

impl Fixture {
    fn new() -> Self {
        let store = Store::disposable(
            Options::core(),
            Catalog::new(1, resources::TABLES),
            Metadata::new([23; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        let registry = Registry::new(credentials.clone(), BTreeMap::new());
        let refreshes = Arc::new(Mutex::new(Vec::new()));
        let reject = Arc::new(AtomicBool::new(false));
        let (seen, rejected) = (refreshes.clone(), reject.clone());
        let registration = registry
            .transform(move |draft| {
                let (seen, rejected) = (seen.clone(), rejected.clone());
                draft.method(
                    "acme".into(),
                    integration::Method::Key(integration::KeyMethod { label: None }),
                );
                draft.oauth(OAuthImplementation {
                    integration: "acme".into(),
                    method: integration::OAuthMethod {
                        id: integration::MethodId::new("browser").unwrap(),
                        label: "Browser".into(),
                        prompts: None,
                        remote: None,
                    },
                    authorize: Arc::new(|_| {
                        Box::pin(async {
                            Ok(Authorization::code(
                                "http://example.invalid/authorize".into(),
                                "Paste code".into(),
                                Arc::new(|_| Box::pin(async { Err(credential::Error::Rejected) })),
                            ))
                        })
                    }),
                    refresh: Some(Arc::new(move |value| {
                        let (seen, rejected) = (seen.clone(), rejected.clone());
                        Box::pin(async move {
                            seen.lock().unwrap().push(value.refresh.to_utf8().unwrap());
                            if rejected.load(Ordering::SeqCst) {
                                return Err(credential::Error::Rejected);
                            }
                            Ok(secret("at-2", "rt-2"))
                        })
                    })),
                    label: None,
                });
            })
            .unwrap();
        Self {
            store,
            credentials,
            registry,
            registration,
            refreshes,
            reject,
        }
    }

    async fn profile(&self, label: &str) -> credential::Info {
        self.credentials
            .create(
                format!("cred_{label}").into(),
                "acme".into(),
                Some(label.into()),
                secret("at-1", "rt-1"),
                1,
            )
            .await
            .unwrap()
    }

    async fn open(&self) -> (Server, Client) {
        locations_ready();
        let mut settings = services(LocalAuth::with_password("fixture"), true);
        let core = settings.core.as_mut().unwrap();
        core.credentials = self.credentials.clone();
        let registry = self.registry.clone();
        core.integrations = Some(Arc::new(move |_| {
            Ok(IntegrationServices {
                registry: registry.clone(),
                wellknown: None,
            })
        }));
        let server = start(settings, standard().unwrap()).await;
        let client = Client::open(server.address(), &[("Authorization", basic("fixture"))])
            .await
            .unwrap();
        (server, client)
    }

    async fn close(self, server: Server) {
        server.shutdown().await.unwrap();
        self.registration.dispose().unwrap();
        self.registry.shutdown().await.unwrap();
        self.credentials.shutdown().await.unwrap();
        self.store.shutdown().unwrap();
    }
}

async fn refresh(client: &mut Client, id: &str) -> v5::CredentialRefreshResult {
    ask(
        client,
        "credential.refresh",
        location_scope(DIRECTORY),
        v5::CredentialRefreshRequest {
            params: v5::CredentialRefreshRequestParams {
                credential_id: text(id),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await
}

async fn connections(client: &mut Client) -> Vec<v5::ConnectionCredentialInfo> {
    let result: v5::IntegrationGetResult = ask(
        client,
        "integration.get",
        location_scope(DIRECTORY),
        v5::IntegrationGetRequest {
            params: v5::IntegrationGetRequestParams {
                integration_id: text("acme"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    let Some(v5::integration_get_result_data::Kind::Value1(info)) = result.data.kind else {
        panic!("acme is registered")
    };
    info.connections
        .items
        .into_iter()
        .map(|connection| {
            let Some(v5::connection_info::Kind::Value1(credential)) = connection.kind else {
                panic!("expected a credential connection")
            };
            credential
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_refresh_rotates_the_token_and_the_list_reports_connected() {
    let fixture = Fixture::new();
    fixture.profile("work").await;
    let (server, mut client) = fixture.open().await;

    let result = refresh(&mut client, "cred_work").await;

    assert_eq!(units(&result.location.directory), DIRECTORY);
    let Some(v5::integration_refresh_result::Kind::Value1(refreshed)) = result.data.kind else {
        panic!("expected a refreshed result")
    };
    assert_eq!(refreshed.status, 1);
    assert_eq!(refreshed.expires, FUTURE as u64);
    assert_eq!(*fixture.refreshes.lock().unwrap(), ["rt-1"]);
    let listed = connections(&mut client).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].status, Some(1));
    assert_eq!(listed[0].message, None);
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_credential_refresh_is_a_failed_result_and_the_list_reports_refresh_failed() {
    let fixture = Fixture::new();
    fixture.profile("work").await;
    fixture.reject.store(true, Ordering::SeqCst);
    let (server, mut client) = fixture.open().await;

    let result = refresh(&mut client, "cred_work").await;

    let Some(v5::integration_refresh_result::Kind::Value2(failed)) = result.data.kind else {
        panic!("expected a failed result")
    };
    assert_eq!(failed.status, 1);
    let message = units(&failed.message);
    assert_eq!(message, credential::Error::Rejected.to_string());
    let listed = connections(&mut client).await;
    assert_eq!(listed[0].status, Some(3));
    assert_eq!(listed[0].message.as_ref().map(units), Some(message));
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connecting_a_key_with_a_credential_id_replaces_that_profile_and_rejects_unknown_targets() {
    let fixture = Fixture::new();
    fixture.profile("work").await;
    let (server, mut client) = fixture.open().await;
    let connect = |key: &str, credential_id: &str| v5::IntegrationConnectKeyRequest {
        params: v5::IntegrationConnectKeyRequestParams {
            integration_id: text("acme"),
        },
        query: query(DIRECTORY, None),
        payload: v5::IntegrationConnectKeyRequestPayload {
            key: text(key),
            label: Some(text("ignored")),
            credential_id: Some(text(credential_id)),
        },
    };

    let rejected: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.connect.key",
        location_scope(DIRECTORY),
        connect("sk-synthetic", "cred_missing"),
    )
    .await;
    let _: v5::IntegrationConnectKeyResult = ask(
        &mut client,
        "integration.connect.key",
        location_scope(DIRECTORY),
        connect("sk-synthetic", "cred_work"),
    )
    .await;

    assert_eq!(units(&rejected.kind.unwrap()), "integration_authorization");
    let profiles = fixture.credentials.list(&"acme".into()).unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].label(), &"work".into());
    assert_eq!(
        profiles[0].secret().domain().unwrap(),
        credential_schema::Value::Key(credential_schema::Key {
            key: "sk-synthetic".into(),
            metadata: None,
        })
    );
    let listed = connections(&mut client).await;
    assert_eq!(listed[0].kind, Some(2));
    assert_eq!(listed[0].status, Some(1));
    fixture.close(server).await;
}
