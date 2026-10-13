mod support;

use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};
use support::{
    wire::{ask, location_scope, query, refuse},
    *,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
};
use ycoding_core::resources::{
    auth::{
        self,
        integration::{
            Authorization, Event, OAuthImplementation, Registration, Registry, WellKnown,
        },
    },
    credential,
    discovery::wellknown,
    mcp::{self, client::Hooks},
};
use ycoding_core::ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, credential as credential_schema,
    integration, schema::NonNegativeInt,
};
use ycoding_core::ycoding_store::{Catalog, Metadata, Options, Store, resources};
use ycoding_protocol::v5;
use ycoding_runtime::{IntegrationServices, LocalAuth, Server, standard};

const DIRECTORY: &str = "/project/integration-wire";
const OTHER: &str = "/project/integration-wire-other";
static NEXT: AtomicUsize = AtomicUsize::new(0);

fn locations_ready() {
    static READY: OnceLock<()> = OnceLock::new();
    READY.get_or_init(|| {
        world()
            .store
            .submit(|tx| {
                for (id, directory) in [
                    ("prj_integration_wire", DIRECTORY),
                    ("prj_integration_wire_other", OTHER),
                ] {
                    ycoding_core::ycoding_store::project::ProjectTable::insert(
                        tx,
                        &ycoding_core::ycoding_store::project::Project {
                            id: id.into(),
                            worktree: directory.into(),
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
                    )?;
                }
                Ok(())
            })
            .unwrap()
            .wait()
            .unwrap();
    });
}

struct Fixture {
    store: Store,
    credentials: credential::Service,
    registry: Registry,
    other: Registry,
    wellknown: Arc<WellKnown>,
    mcp: Arc<mcp::Service>,
    root: std::path::PathBuf,
    registrations: Vec<Registration>,
}

impl Fixture {
    fn new() -> Self {
        let store = Store::disposable(
            Options::core(),
            Catalog::new(1, resources::TABLES),
            Metadata::new([19; 16], 1),
        )
        .unwrap();
        let credentials = credential::Service::new(store.client());
        let registry = Registry::new(
            credentials.clone(),
            BTreeMap::from([("SYNTH_KEY".into(), "env-secret".into())]),
        );
        let other = Registry::new(credentials.clone(), BTreeMap::new());
        let wellknown = Arc::new(WellKnown::new(
            wellknown::Service::new(store.client(), BTreeMap::new()).unwrap(),
        ));
        let root = std::env::temp_dir().join(format!(
            "ycoding-integration-mcp-wire-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mcp = Arc::new(
            mcp::Service::new(
                &[],
                root.clone(),
                "fixture".into(),
                BTreeMap::new(),
                Hooks {
                    integrations: Some(registry.clone()),
                    credentials: Some(credentials.clone()),
                    ..Hooks::default()
                },
            )
            .unwrap(),
        );
        Self {
            store,
            credentials,
            registry,
            other,
            wellknown,
            mcp,
            root,
            registrations: Vec::new(),
        }
    }
    async fn open(&self) -> (Server, Client) {
        locations_ready();
        self.wellknown.attach(&self.registry).await.unwrap();
        self.wellknown.attach(&self.other).await.unwrap();
        let mut settings = services(LocalAuth::with_password("fixture"), true);
        let core = settings.core.as_mut().unwrap();
        core.credentials = self.credentials.clone();
        let registry = self.registry.clone();
        let other = self.other.clone();
        let wellknown = self.wellknown.clone();
        core.integrations = Some(Arc::new(move |location| {
            assert!(location.workspace_id.is_none());
            Ok(IntegrationServices {
                registry: if location.directory.as_lossless().as_str() == Some(OTHER) {
                    other.clone()
                } else {
                    registry.clone()
                },
                wellknown: Some(wellknown.clone()),
            })
        }));
        let mcp = self.mcp.clone();
        core.mcp = Some(Arc::new(move |location| {
            assert_eq!(location.directory.as_lossless().as_str(), Some(DIRECTORY));
            Ok(mcp.clone())
        }));
        let server = start(settings, standard().unwrap()).await;
        let client = Client::open(server.address(), &[("Authorization", basic("fixture"))])
            .await
            .unwrap();
        (server, client)
    }
    fn method(&mut self, id: &str, method: integration::Method) {
        let id = LosslessString::from(id);
        self.registrations.push(
            self.registry
                .transform(move |draft| draft.method(id.clone(), method.clone()))
                .unwrap(),
        );
    }
    fn oauth(
        &mut self,
        id: &str,
        method: &str,
        authorize: impl Fn(
            integration::Inputs,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Authorization, credential::Error>> + Send>,
        > + Send
        + Sync
        + 'static,
    ) {
        let implementation = OAuthImplementation {
            integration: id.into(),
            method: integration::OAuthMethod {
                id: integration::MethodId::new(method).unwrap(),
                label: method.into(),
                prompts: None,
                remote: None,
            },
            authorize: Arc::new(authorize),
            refresh: None,
            label: None,
        };
        self.registrations.push(
            self.registry
                .transform(move |draft| draft.oauth(implementation.clone()))
                .unwrap(),
        );
    }
    async fn close(self, server: Server) {
        server.shutdown().await.unwrap();
        self.mcp.shutdown().await.unwrap();
        self.registry.shutdown().await.unwrap();
        self.other.shutdown().await.unwrap();
        self.credentials.shutdown().await.unwrap();
        self.store.shutdown().unwrap();
        std::fs::remove_dir_all(self.root).unwrap();
    }
}

fn secret(method: &str) -> resources::Secret {
    resources::Secret::new(
        credential_schema::Value::OAuth(credential_schema::OAuth {
            method_id: integration::MethodId::new(method).unwrap(),
            access: "oauth-secret".into(),
            refresh: "refresh-secret".into(),
            expires: NonNegativeInt::new(100000).unwrap(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

async fn get(client: &mut Client, id: &str, directory: &str) -> Option<v5::IntegrationInfo> {
    let result: v5::IntegrationGetResult = ask(
        client,
        "integration.get",
        location_scope(directory),
        v5::IntegrationGetRequest {
            params: v5::IntegrationGetRequestParams {
                integration_id: text(id),
            },
            query: query(directory, None),
        },
    )
    .await;
    assert_eq!(units(&result.location.directory), directory);
    match result.data.kind.unwrap() {
        v5::integration_get_result_data::Kind::Value1(info) => Some(info),
        v5::integration_get_result_data::Kind::None(_) => None,
    }
}

async fn oauth_connect(client: &mut Client, id: &str, method: &str) -> v5::IntegrationAttempt {
    let result: v5::IntegrationOauthConnectResult = ask(
        client,
        "integration.oauth.connect",
        location_scope(DIRECTORY),
        v5::IntegrationOauthConnectRequest {
            params: v5::IntegrationOauthConnectRequestParams {
                integration_id: text(id),
            },
            query: query(DIRECTORY, None),
            payload: v5::IntegrationOauthConnectRequestPayload {
                method_id: text(method),
                inputs: v5::IntegrationOauthConnectRequestPayloadInputs {
                    entries: vec![v5::IntegrationOauthConnectRequestPayloadInputsEntry {
                        key: text("answer"),
                        value: text("yes"),
                    }],
                },
                label: Some(text("Profile")),
            },
        },
    )
    .await;
    result.data
}

fn completion(
    id: &str,
    attempt: &v5::IntegrationAttempt,
    code: Option<&str>,
) -> v5::IntegrationOauthCompleteRequest {
    v5::IntegrationOauthCompleteRequest {
        params: v5::IntegrationOauthCompleteRequestParams {
            integration_id: text(id),
            attempt_id: attempt.attempt_id.clone(),
        },
        query: query(DIRECTORY, None),
        payload: v5::IntegrationOauthCompleteRequestPayload {
            code: code.map(text),
        },
    }
}

async fn status(
    client: &mut Client,
    id: &str,
    attempt: &v5::IntegrationAttempt,
) -> v5::IntegrationAttemptStatus {
    let result: v5::IntegrationOauthStatusResult = ask(
        client,
        "integration.oauth.status",
        location_scope(DIRECTORY),
        v5::IntegrationOauthStatusRequest {
            params: v5::IntegrationOauthStatusRequestParams {
                integration_id: text(id),
                attempt_id: attempt.attempt_id.clone(),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    result.data
}

async fn cancel(client: &mut Client, id: &str, attempt: &v5::IntegrationAttempt) {
    let _: v5::IntegrationOauthCancelResult = ask(
        client,
        "integration.oauth.cancel",
        location_scope(DIRECTORY),
        v5::IntegrationOauthCancelRequest {
            params: v5::IntegrationOauthCancelRequestParams {
                integration_id: text(id),
                attempt_id: attempt.attempt_id.clone(),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
}

async fn connected(events: &mut tokio::sync::broadcast::Receiver<Event>) {
    tokio::time::timeout(WAIT, async {
        loop {
            if matches!(events.recv().await.unwrap(), Event::ConnectionUpdated(_)) {
                return;
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn listing_registration_key_profiles_and_location_fences_match_ts() {
    let mut fixture = Fixture::new();
    fixture.method(
        "zebra",
        integration::Method::Key(integration::KeyMethod {
            label: Some("API key".into()),
        }),
    );
    fixture.method(
        "zebra",
        integration::Method::Env(integration::EnvMethod {
            names: vec!["SYNTH_KEY".into(), "MISSING_KEY".into()],
        }),
    );
    fixture.registrations.push(
        fixture
            .registry
            .transform(|draft| draft.update("alpha".into(), |entry| entry.name = "Alpha".into()))
            .unwrap(),
    );
    fixture.method(
        "alpha",
        integration::Method::OAuth(integration::OAuthMethod {
            id: integration::MethodId::new("browser").unwrap(),
            label: "Browser".into(),
            remote: Some(false),
            prompts: Some(vec![
                integration::Prompt::Text(integration::TextPrompt {
                    key: "text".into(),
                    message: LosslessString::from_utf16(vec![0xd800]),
                    placeholder: Some("hint".into()),
                    when: Some(integration::When {
                        key: "mode".into(),
                        op: "eq".into(),
                        value: "work".into(),
                    }),
                }),
                integration::Prompt::Select(integration::SelectPrompt {
                    key: "mode".into(),
                    message: "Choose".into(),
                    options: vec![integration::SelectOption {
                        label: "Work".into(),
                        value: "work".into(),
                        hint: Some("choice".into()),
                    }],
                    when: Some(integration::When {
                        key: "text".into(),
                        op: "neq".into(),
                        value: "".into(),
                    }),
                }),
            ]),
        }),
    );
    let override_registration = fixture
        .registry
        .transform(|draft| draft.update("alpha".into(), |entry| entry.name = "Override".into()))
        .unwrap();
    let (server, mut client) = fixture.open().await;
    assert!(Socket::connect(server.address(), &[]).await.is_err());
    assert_eq!(
        units(&get(&mut client, "alpha", DIRECTORY).await.unwrap().name),
        "Override"
    );
    override_registration.dispose().unwrap();
    assert_eq!(
        units(&get(&mut client, "alpha", DIRECTORY).await.unwrap().name),
        "Alpha"
    );
    assert!(get(&mut client, "unknown", DIRECTORY).await.is_none());
    assert!(get(&mut client, "zebra", OTHER).await.is_none());
    let list: v5::IntegrationListResult = ask(
        &mut client,
        "integration.list",
        location_scope(DIRECTORY),
        v5::IntegrationListRequest {
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert_eq!(
        list.data
            .items
            .iter()
            .map(|item| units(&item.id))
            .collect::<Vec<_>>(),
        ["alpha", "zebra"]
    );
    let Some(v5::integration_method::Kind::Value1(method)) =
        &list.data.items[0].methods.items[0].kind
    else {
        panic!("OAuth method")
    };
    assert_eq!(method.remote, Some(false));
    let prompts = method.prompts.as_ref().unwrap();
    let Some(v5::integration_o_auth_method_prompts_item::Kind::Value1(prompt)) =
        &prompts.items[0].kind
    else {
        panic!("text prompt")
    };
    assert_eq!(
        ycoding_protocol::decode_lossless(&prompt.message, 8).unwrap(),
        [0xd800]
    );
    assert_eq!(prompt.when.as_ref().unwrap().op, 1);
    let Some(v5::integration_o_auth_method_prompts_item::Kind::Value2(prompt)) =
        &prompts.items[1].kind
    else {
        panic!("select prompt")
    };
    assert_eq!(prompt.when.as_ref().unwrap().op, 2);
    assert_eq!(
        units(prompt.options.items[0].hint.as_ref().unwrap()),
        "choice"
    );
    let mismatch: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.list",
        location_scope(DIRECTORY),
        v5::IntegrationListRequest {
            query: query(OTHER, None),
        },
    )
    .await;
    assert!(units(&mismatch.message).contains("disagree"));
    for label in ["First", "Second"] {
        let _: v5::IntegrationConnectKeyResult = ask(
            &mut client,
            "integration.connect.key",
            location_scope(DIRECTORY),
            v5::IntegrationConnectKeyRequest {
                params: v5::IntegrationConnectKeyRequestParams {
                    integration_id: text("zebra"),
                },
                query: query(DIRECTORY, None),
                payload: v5::IntegrationConnectKeyRequestPayload {
                    key: text("key-secret"),
                    label: Some(text(label)),
                },
            },
        )
        .await;
    }
    let info = get(&mut client, "zebra", DIRECTORY).await.unwrap();
    let profile = |index: usize| {
        let v5::connection_info::Kind::Value1(profile) =
            info.connections.items[index].kind.as_ref().unwrap()
        else {
            panic!("credential")
        };
        profile
    };
    assert_eq!(units(&profile(0).label), "Second");
    assert!(profile(0).active);
    assert!(!profile(1).active);
    assert_eq!(
        units(&profile(0).id),
        fixture.credentials.list(&"zebra".into()).unwrap()[1]
            .id()
            .as_str()
            .unwrap()
    );
    assert!(matches!(
        info.connections.items[2].kind,
        Some(v5::connection_info::Kind::Value2(_))
    ));
    assert!(!format!("{info:?}").contains("key-secret"));
    let rows = fixture.credentials.list(&"zebra".into()).unwrap();
    fixture
        .registry
        .activate(rows[0].id().clone(), 99)
        .await
        .unwrap();
    let info = get(&mut client, "zebra", DIRECTORY).await.unwrap();
    let Some(v5::connection_info::Kind::Value1(profile)) = &info.connections.items[0].kind else {
        panic!("profile")
    };
    assert_eq!(units(&profile.label), "First");
    let rejected: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.connect.key",
        location_scope(DIRECTORY),
        v5::IntegrationConnectKeyRequest {
            params: v5::IntegrationConnectKeyRequestParams {
                integration_id: text("unknown"),
            },
            query: query(DIRECTORY, None),
            payload: v5::IntegrationConnectKeyRequestPayload {
                key: text("never-saved"),
                label: None,
            },
        },
    )
    .await;
    assert_eq!(units(&rejected.kind.unwrap()), "integration_authorization");
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn code_oauth_claims_once_requires_code_and_preserves_owner_expiry_and_cancellation() {
    let mut fixture = Fixture::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    fixture.oauth("oauth", "code", move |inputs| {
        assert_eq!(
            inputs.0.get(&"answer".into()),
            Some(&JsonValue::String("yes".into()))
        );
        let calls = observed.clone();
        Box::pin(async move {
            Ok(Authorization::code(
                "http://example.invalid/authorize".into(),
                "Paste code".into(),
                Arc::new(move |code| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async move {
                        if code == "good" {
                            Ok(secret("code"))
                        } else {
                            Err(credential::Error::Rejected)
                        }
                    })
                }),
            ))
        })
    });
    fixture.oauth("oauth", "expired", |_| {
        Box::pin(async {
            Ok(Authorization::automatic(
                "http://example.invalid/authorize".into(),
                "Expiring".into(),
                Box::pin(std::future::pending()),
                None,
                Some(1),
            ))
        })
    });
    let (server, mut client) = fixture.open().await;
    let attempt = oauth_connect(&mut client, "oauth", "code").await;
    assert_eq!(attempt.mode, 2);
    let missing: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("oauth", &attempt, None),
    )
    .await;
    assert_eq!(units(&missing.kind.unwrap()), "integration_code_required");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let wrong: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("wrong", &attempt, Some("good")),
    )
    .await;
    assert_eq!(units(&wrong.kind.unwrap()), "integration_authorization");
    assert!(matches!(
        status(&mut client, "oauth", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value1(_))
    ));
    let _: v5::IntegrationOauthCompleteResult = ask(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("oauth", &attempt, Some("good")),
    )
    .await;
    let _: v5::IntegrationOauthCompleteResult = ask(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("oauth", &attempt, Some("different")),
    )
    .await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.credentials.list(&"oauth".into()).unwrap().len(), 1);
    let settled = status(&mut client, "oauth", &attempt).await;
    assert!(matches!(
        settled.kind,
        Some(v5::integration_attempt_status::Kind::Value2(_))
    ));
    assert!(!format!("{settled:?}").contains("oauth-secret"));
    cancel(&mut client, "oauth", &attempt).await;
    assert!(matches!(
        status(&mut client, "oauth", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value2(_))
    ));
    let failed = oauth_connect(&mut client, "oauth", "code").await;
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("oauth", &failed, Some("bad")),
    )
    .await;
    assert!(matches!(
        status(&mut client, "oauth", &failed).await.kind,
        Some(v5::integration_attempt_status::Kind::Value3(_))
    ));
    let cancelled = oauth_connect(&mut client, "oauth", "code").await;
    cancel(&mut client, "wrong", &cancelled).await;
    assert!(matches!(
        status(&mut client, "oauth", &cancelled).await.kind,
        Some(v5::integration_attempt_status::Kind::Value1(_))
    ));
    cancel(&mut client, "oauth", &cancelled).await;
    cancel(&mut client, "oauth", &cancelled).await;
    assert!(
        fixture
            .registry
            .status(
                &"oauth".into(),
                &integration::AttemptId(units(&cancelled.attempt_id).into())
            )
            .is_err()
    );
    let expired = oauth_connect(&mut client, "oauth", "expired").await;
    fixture.registry.scrub(2).await.unwrap();
    assert!(matches!(
        status(&mut client, "oauth", &expired).await.kind,
        Some(v5::integration_attempt_status::Kind::Value4(_))
    ));
    let _: v5::IntegrationOauthCompleteResult = ask(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("oauth", &expired, Some("ignored")),
    )
    .await;
    fixture.registry.scrub(60_002).await.unwrap();
    assert!(
        fixture
            .registry
            .status(
                &"oauth".into(),
                &integration::AttemptId(units(&expired.attempt_id).into())
            )
            .is_err()
    );
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn automatic_manual_submission_is_single_owned_cancelable_and_callback_settled() {
    let mut fixture = Fixture::new();
    let finish = Arc::new(Notify::new());
    let submitted = Arc::new(AtomicUsize::new(0));
    let callback_finish = finish.clone();
    let submissions = submitted.clone();
    fixture.oauth("manual", "auto", move |_| {
        let finish = callback_finish.clone();
        let submissions = submissions.clone();
        Box::pin(async move {
            Ok(Authorization::automatic(
                "http://example.invalid/authorize".into(),
                "Browser".into(),
                Box::pin(async move {
                    finish.notified().await;
                    Ok(secret("auto"))
                }),
                Some(Arc::new(move |code| {
                    assert_eq!(code, "code#state");
                    submissions.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Ok(()) })
                })),
                None,
            ))
        })
    });
    let (server, mut client) = fixture.open().await;
    let attempt = oauth_connect(&mut client, "manual", "auto").await;
    assert_eq!(attempt.manual_code, Some(true));
    for code in [None, Some(" ")] {
        let error: v5::InvalidRequestError = refuse(
            &mut client,
            "integration.oauth.complete",
            location_scope(DIRECTORY),
            completion("manual", &attempt, code),
        )
        .await;
        assert_eq!(units(&error.kind.unwrap()), "integration_code_required");
    }
    let _: v5::IntegrationOauthCompleteResult = ask(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("manual", &attempt, Some("code#state")),
    )
    .await;
    assert!(fixture.credentials.all().unwrap().is_empty());
    assert!(matches!(
        status(&mut client, "manual", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value1(_))
    ));
    let _: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("manual", &attempt, Some("code#state")),
    )
    .await;
    assert_eq!(submitted.load(Ordering::SeqCst), 1);
    let mut events = fixture.registry.subscribe();
    finish.notify_one();
    connected(&mut events).await;
    assert!(matches!(
        status(&mut client, "manual", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value2(_))
    ));
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_interrupts_inflight_manual_submission_and_rejects_late_persistence() {
    let mut fixture = Fixture::new();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let finished = Arc::new(AtomicUsize::new(0));
    let started_submission = started.clone();
    let release_submission = release.clone();
    let submitted = finished.clone();
    fixture.oauth("cancel", "auto", move |_| {
        let started = started_submission.clone();
        let release = release_submission.clone();
        let submitted = submitted.clone();
        Box::pin(async move {
            Ok(Authorization::automatic(
                "http://example.invalid/authorize".into(),
                "Browser".into(),
                Box::pin(std::future::pending()),
                Some(Arc::new(move |_| {
                    let started = started.clone();
                    let release = release.clone();
                    let submitted = submitted.clone();
                    Box::pin(async move {
                        started.notify_one();
                        release.notified().await;
                        submitted.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    })
                })),
                None,
            ))
        })
    });
    let (server, mut client) = fixture.open().await;
    let attempt = oauth_connect(&mut client, "cancel", "auto").await;
    let mut second = Client::open(server.address(), &[("Authorization", basic("fixture"))])
        .await
        .unwrap();
    let completion = completion("cancel", &attempt, Some("code"));
    tokio::time::timeout(WAIT, async {
        tokio::join!(
            refuse::<_, v5::InvalidRequestError>(
                &mut second,
                "integration.oauth.complete",
                location_scope(DIRECTORY),
                completion
            ),
            async {
                started.notified().await;
                cancel(&mut client, "cancel", &attempt).await;
                release.notify_one();
            },
        );
    })
    .await
    .unwrap();
    assert_eq!(finished.load(Ordering::SeqCst), 0);
    assert!(fixture.credentials.all().unwrap().is_empty());
    fixture.close(server).await;
}

async fn command_status(
    client: &mut Client,
    id: &str,
    attempt: &v5::IntegrationCommandAttempt,
) -> v5::IntegrationCommandAttemptStatus {
    let result: v5::IntegrationCommandStatusResult = ask(
        client,
        "integration.command.status",
        location_scope(DIRECTORY),
        v5::IntegrationCommandStatusRequest {
            params: v5::IntegrationCommandStatusRequestParams {
                integration_id: text(id),
                attempt_id: attempt.attempt_id.clone(),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    result.data
}

async fn command_connect(
    client: &mut Client,
    id: &str,
    method: &str,
) -> v5::IntegrationCommandAttempt {
    let result: v5::IntegrationCommandConnectResult = ask(
        client,
        "integration.command.connect",
        location_scope(DIRECTORY),
        v5::IntegrationCommandConnectRequest {
            params: v5::IntegrationCommandConnectRequestParams {
                integration_id: text(id),
            },
            query: query(DIRECTORY, None),
            payload: v5::IntegrationCommandConnectRequestPayload {
                method_id: text(method),
                label: Some(text("Command profile")),
            },
        },
    )
    .await;
    result.data
}

async fn wait_command(
    fixture: &Fixture,
    attempt: &v5::IntegrationCommandAttempt,
    predicate: impl Fn(&integration::CommandAttemptStatus) -> bool,
) {
    tokio::time::timeout(WAIT, async {
        loop {
            if predicate(
                &fixture
                    .registry
                    .command_status(
                        &"command".into(),
                        &integration::AttemptId(units(&attempt.attempt_id).into()),
                    )
                    .unwrap(),
            ) {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_progress_success_failures_and_cancellation_reap_the_owned_process() {
    let mut fixture = Fixture::new();
    let release = fixture.root.join("release");
    let pid = fixture.root.join("pid");
    let script = format!(
        "import os,sys,time\nopen({:?},'w').write(str(os.getpid()))\nsys.stderr.write('http://example.invalid/login\\n');sys.stderr.flush()\nwhile not os.path.exists({:?}): time.sleep(0.01)\nprint('stdout-secret')\n",
        pid.to_str().unwrap(),
        release.to_str().unwrap()
    );
    for (method, script) in [
        ("success", script.clone()),
        ("cancel", script),
        (
            "failed",
            "import sys;sys.stderr.write('Command rejected');sys.exit(3)".into(),
        ),
        ("empty", "print('  ')".into()),
    ] {
        fixture.method(
            "command",
            integration::Method::Command(integration::CommandMethod {
                id: integration::MethodId::new(method).unwrap(),
                label: method.into(),
                command: vec!["/usr/bin/python3".into(), "-c".into(), script.into()],
            }),
        );
    }
    let (server, mut client) = fixture.open().await;
    let attempt = command_connect(&mut client, "command", "success").await;
    wait_command(&fixture, &attempt, |status| {
        matches!(
            status,
            integration::CommandAttemptStatus::Pending {
                message: Some(_),
                ..
            }
        )
    })
    .await;
    let Some(v5::integration_command_attempt_status::Kind::Value1(pending)) =
        command_status(&mut client, "command", &attempt).await.kind
    else {
        panic!("pending")
    };
    assert_eq!(
        units(pending.message.as_ref().unwrap()),
        "http://example.invalid/login\n"
    );
    let mut events = fixture.registry.subscribe();
    std::fs::write(&release, "release").unwrap();
    connected(&mut events).await;
    let status = command_status(&mut client, "command", &attempt).await;
    assert!(matches!(
        status.kind,
        Some(v5::integration_command_attempt_status::Kind::Value2(_))
    ));
    assert!(!format!("{status:?}").contains("stdout-secret"));
    let stored = fixture.credentials.list(&"command".into()).unwrap();
    assert_eq!(stored.len(), 1);
    let credential_schema::Value::Key(key) = stored[0].secret().domain().unwrap() else {
        panic!("key")
    };
    assert_eq!(key.key.as_str(), Some("stdout-secret"));
    for (method, message) in [
        ("failed", "Command rejected"),
        ("empty", "Authentication command returned no credential"),
    ] {
        let attempt = command_connect(&mut client, "command", method).await;
        wait_command(&fixture, &attempt, |status| {
            matches!(status, integration::CommandAttemptStatus::Failed { .. })
        })
        .await;
        let Some(v5::integration_command_attempt_status::Kind::Value3(status)) =
            command_status(&mut client, "command", &attempt).await.kind
        else {
            panic!("failed")
        };
        assert_eq!(units(&status.message), message);
    }
    std::fs::remove_file(&release).unwrap();
    let attempt = command_connect(&mut client, "command", "cancel").await;
    wait_command(&fixture, &attempt, |status| {
        matches!(
            status,
            integration::CommandAttemptStatus::Pending {
                message: Some(_),
                ..
            }
        )
    })
    .await;
    let process_id = std::fs::read_to_string(&pid)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    let _: v5::IntegrationCommandCancelResult = ask(
        &mut client,
        "integration.command.cancel",
        location_scope(DIRECTORY),
        v5::IntegrationCommandCancelRequest {
            params: v5::IntegrationCommandCancelRequestParams {
                integration_id: text("command"),
                attempt_id: attempt.attempt_id.clone(),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert!(!ycoding_core::platform::process::is_alive(process_id).unwrap());
    assert!(
        fixture
            .registry
            .command_status(
                &"command".into(),
                &integration::AttemptId(units(&attempt.attempt_id).into())
            )
            .is_err()
    );
    assert_eq!(
        fixture.credentials.list(&"command".into()).unwrap().len(),
        1
    );
    let expiring = command_connect(&mut client, "command", "cancel").await;
    wait_command(&fixture, &expiring, |status| {
        matches!(
            status,
            integration::CommandAttemptStatus::Pending {
                message: Some(_),
                ..
            }
        )
    })
    .await;
    let expired_pid = std::fs::read_to_string(&pid)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    fixture
        .registry
        .scrub(expiring.time.expires as i64 + 1)
        .await
        .unwrap();
    assert!(matches!(
        command_status(&mut client, "command", &expiring).await.kind,
        Some(v5::integration_command_attempt_status::Kind::Value4(_))
    ));
    assert!(!ycoding_core::platform::process::is_alive(expired_pid).unwrap());
    let shutting_down = command_connect(&mut client, "command", "cancel").await;
    wait_command(&fixture, &shutting_down, |status| {
        matches!(
            status,
            integration::CommandAttemptStatus::Pending {
                message: Some(_),
                ..
            }
        )
    })
    .await;
    let shutdown_pid = std::fs::read_to_string(&pid)
        .unwrap()
        .parse::<u32>()
        .unwrap();
    fixture.close(server).await;
    assert!(!ycoding_core::platform::process::is_alive(shutdown_pid).unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_code_completion_claims_one_callback_and_one_credential() {
    let mut fixture = Fixture::new();
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let callback_started = started.clone();
    let callback_release = release.clone();
    let callbacks = calls.clone();
    fixture.oauth("concurrent", "code", move |_| {
        let started = callback_started.clone();
        let release = callback_release.clone();
        let calls = callbacks.clone();
        Box::pin(async move {
            Ok(Authorization::code(
                "http://example.invalid/authorize".into(),
                "Paste code".into(),
                Arc::new(move |_| {
                    let started = started.clone();
                    let release = release.clone();
                    let calls = calls.clone();
                    Box::pin(async move {
                        calls.fetch_add(1, Ordering::SeqCst);
                        started.notify_one();
                        release.notified().await;
                        Ok(secret("code"))
                    })
                }),
            ))
        })
    });
    let (server, mut client) = fixture.open().await;
    let attempt = oauth_connect(&mut client, "concurrent", "code").await;
    let mut second = Client::open(server.address(), &[("Authorization", basic("fixture"))])
        .await
        .unwrap();
    tokio::time::timeout(WAIT, async {
        tokio::join!(
            ask::<_, v5::IntegrationOauthCompleteResult>(
                &mut client,
                "integration.oauth.complete",
                location_scope(DIRECTORY),
                completion("concurrent", &attempt, Some("first"))
            ),
            async {
                started.notified().await;
                let _: v5::InvalidRequestError = refuse(
                    &mut second,
                    "integration.oauth.complete",
                    location_scope(DIRECTORY),
                    completion("concurrent", &attempt, Some("second")),
                )
                .await;
                release.notify_one();
            },
        );
    })
    .await
    .unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.credentials.all().unwrap().len(), 1);
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn manual_submission_rejection_fails_attempt_and_store_failure_is_terminal() {
    let mut fixture = Fixture::new();
    fixture.oauth("submission", "auto", |_| {
        Box::pin(async {
            Ok(Authorization::automatic(
                "http://example.invalid/authorize".into(),
                "Browser".into(),
                Box::pin(std::future::pending()),
                Some(Arc::new(|_| {
                    Box::pin(async { Err(credential::Error::Rejected) })
                })),
                None,
            ))
        })
    });
    fixture.oauth("persistence", "code", |_| {
        Box::pin(async {
            Ok(Authorization::code(
                "http://example.invalid/authorize".into(),
                "Paste code".into(),
                Arc::new(|_| Box::pin(async { Ok(secret("code")) })),
            ))
        })
    });
    let (server, mut client) = fixture.open().await;
    let attempt = oauth_connect(&mut client, "submission", "auto").await;
    let error: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("submission", &attempt, Some("rejected")),
    )
    .await;
    assert_eq!(units(&error.kind.unwrap()), "integration_authorization");
    assert!(matches!(
        status(&mut client, "submission", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value3(_))
    ));
    assert!(fixture.credentials.all().unwrap().is_empty());
    let attempt = oauth_connect(&mut client, "persistence", "code").await;
    fixture.store.shutdown().unwrap();
    let error: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.oauth.complete",
        location_scope(DIRECTORY),
        completion("persistence", &attempt, Some("code")),
    )
    .await;
    assert_eq!(units(&error.kind.unwrap()), "integration_authorization");
    assert!(matches!(
        status(&mut client, "persistence", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value3(_))
    ));
    server.shutdown().await.unwrap();
    fixture.mcp.shutdown().await.unwrap();
    fixture.registry.shutdown().await.unwrap();
    fixture.other.shutdown().await.unwrap();
    fixture.credentials.shutdown().await.unwrap();
    std::fs::remove_dir_all(fixture.root).unwrap();
}

struct HttpFixture {
    url: String,
    body: Arc<Mutex<String>>,
    requests: Arc<Mutex<Vec<String>>>,
    task: tokio::task::JoinHandle<()>,
}
impl HttpFixture {
    async fn new(body: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let body = Arc::new(Mutex::new(body.to_owned()));
        let response = body.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let observed = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0; 4096];
                let end = loop {
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break None;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                        break Some(end + 4);
                    }
                };
                let Some(end) = end else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&bytes[..end]);
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.split_once(':')
                            .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                            .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                while bytes.len() < end + length {
                    let count = stream.read(&mut buffer).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                observed
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&bytes).into_owned());
                let body = response.lock().unwrap().clone();
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
            }
        });
        Self {
            url,
            body,
            requests,
            task,
        }
    }
    async fn close(self) {
        self.task.abort();
        assert!(self.task.await.unwrap_err().is_cancelled());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wellknown_validates_registers_normalizes_deduplicates_and_persists_sources() {
    let fixture = Fixture::new();
    let http = HttpFixture::new(r#"{"auth":{"command":["login"],"env":"TOKEN"}}"#).await;
    let (server, mut client) = fixture.open().await;
    for _ in 0..2 {
        let _: v5::IntegrationWellknownAddResult = ask(
            &mut client,
            "integration.wellknown.add",
            location_scope(DIRECTORY),
            v5::IntegrationWellknownAddRequest {
                query: query(DIRECTORY, None),
                payload: v5::IntegrationWellknownAddRequestPayload {
                    url: text(&format!("{}///", http.url)),
                },
            },
        )
        .await;
    }
    let info = get(&mut client, &http.url, DIRECTORY).await.unwrap();
    assert!(get(&mut client, &http.url, OTHER).await.is_some());
    assert_eq!(units(&info.name), "127.0.0.1");
    let Some(v5::integration_method::Kind::Value2(method)) = &info.methods.items[0].kind else {
        panic!("command method")
    };
    assert_eq!(units(&method.id), "login");
    assert_eq!(units(&method.command.items[0]), "login");
    let stored = resources::get_kv(
        &fixture.store.client().snapshot().unwrap(),
        &wellknown::SOURCES_KEY.into(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        Vec::<LosslessString>::decode(stored.value()).unwrap(),
        [LosslessString::from(http.url.as_str())]
    );
    for body in ["{}", r#"{"auth":{"command":3,"env":"TOKEN"}}"#, "not-json"] {
        *http.body.lock().unwrap() = body.into();
        let error: v5::InvalidRequestError = refuse(
            &mut client,
            "integration.wellknown.add",
            location_scope(DIRECTORY),
            v5::IntegrationWellknownAddRequest {
                query: query(DIRECTORY, None),
                payload: v5::IntegrationWellknownAddRequestPayload {
                    url: text(&http.url),
                },
            },
        )
        .await;
        assert_eq!(units(&error.kind.unwrap()), "well_known_discovery");
        assert_eq!(
            units(&error.message),
            if body == "{}" {
                format!("No authentication method found at {}", http.url)
            } else {
                format!(
                    "Failed to load wellknown manifest from {}/.well-known/ycoding",
                    http.url
                )
            }
        );
        assert!(get(&mut client, &http.url, DIRECTORY).await.is_some());
    }
    assert!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("GET /.well-known/ycoding "))
    );
    http.close().await;
    fixture.close(server).await;
}

fn percent_decode(value: &str) -> String {
    let mut bytes = Vec::new();
    let mut input = value.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let first = input.next().unwrap();
            let second = input.next().unwrap();
            bytes.push(
                u8::from_str_radix(std::str::from_utf8(&[first, second]).unwrap(), 16).unwrap(),
            );
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).unwrap()
}
fn url_param(url: &str, key: &str) -> String {
    percent_decode(
        url.split_once('?')
            .unwrap()
            .1
            .split('&')
            .find_map(|entry| {
                entry
                    .split_once('=')
                    .filter(|(name, _)| *name == key)
                    .map(|(_, value)| value)
            })
            .unwrap(),
    )
}
async fn http_get(url: &str) -> String {
    let (host, path) = url
        .strip_prefix("http://")
        .unwrap()
        .split_once('/')
        .unwrap();
    let mut socket = TcpStream::connect(host).await.unwrap();
    socket
        .write_all(
            format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n").as_bytes(),
        )
        .await
        .unwrap();
    let mut bytes = Vec::new();
    socket.read_to_end(&mut bytes).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn oauth_wire_drives_real_loopback_state_pkce_exchange_and_closes_on_cancel() {
    let mut fixture = Fixture::new();
    let http = HttpFixture::new(r#"{"access_token":"loopback-secret","refresh_token":"refresh-secret","id_token":"invalid"}"#).await;
    let client = auth::Client::new(&http.url, "fixture").unwrap();
    fixture.oauth("browser", "browser", move |_| {
        let client = client.clone();
        Box::pin(async move {
            let mut browser = client
                .start_browser("openai", "chatgpt-browser", Some(0))
                .await?;
            Ok(Authorization::automatic(
                browser.url().into(),
                "Authorize".into(),
                Box::pin(async move { browser.wait().await }),
                None,
                None,
            ))
        })
    });
    let (server, mut client) = fixture.open().await;
    let attempt = oauth_connect(&mut client, "browser", "browser").await;
    let url = units(&attempt.url);
    let redirect = url_param(&url, "redirect_uri");
    assert_eq!(url_param(&url, "code_challenge_method"), "S256");
    let mut events = fixture.registry.subscribe();
    let html = http_get(&format!(
        "{redirect}?code=fixture-code&state={}",
        url_param(&url, "state")
    ))
    .await;
    assert!(html.starts_with("HTTP/1.1 200"));
    assert!(!html.contains("loopback-secret"));
    connected(&mut events).await;
    let requests = http.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("code_verifier="));
    assert!(requests[0].contains("code=fixture-code"));
    let exchange = requests[0].split_once("\r\n\r\n").unwrap().1;
    let verifier = url_param(&format!("http://fixture?{exchange}"), "code_verifier");
    let challenge = std::process::Command::new("/usr/bin/python3")
        .args(["-c", "import base64,hashlib,sys;print(base64.urlsafe_b64encode(hashlib.sha256(sys.argv[1].encode()).digest()).decode().rstrip('='))", &verifier])
        .output().unwrap();
    assert!(challenge.status.success());
    assert_eq!(
        String::from_utf8(challenge.stdout).unwrap().trim(),
        url_param(&url, "code_challenge")
    );
    assert_eq!(
        url_param(&format!("http://fixture?{exchange}"), "redirect_uri"),
        redirect
    );
    assert!(matches!(
        status(&mut client, "browser", &attempt).await.kind,
        Some(v5::integration_attempt_status::Kind::Value2(_))
    ));
    let invalid = oauth_connect(&mut client, "browser", "browser").await;
    let invalid_redirect = url_param(&units(&invalid.url), "redirect_uri");
    assert!(
        http_get(&format!("{invalid_redirect}?code=fixture-code&state=wrong"))
            .await
            .starts_with("HTTP/1.1 400")
    );
    tokio::time::timeout(WAIT, async {
        loop {
            if matches!(
                status(&mut client, "browser", &invalid).await.kind,
                Some(v5::integration_attempt_status::Kind::Value3(_))
            ) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(http.requests.lock().unwrap().len(), 1);
    let cancelled = oauth_connect(&mut client, "browser", "browser").await;
    let redirect = url_param(&units(&cancelled.url), "redirect_uri");
    cancel(&mut client, "browser", &cancelled).await;
    let host = redirect
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    assert!(TcpStream::connect(host).await.is_err());
    http.close().await;
    fixture.close(server).await;
}

const MCP_SCRIPT: &str = r#"import json,os,sys
for line in sys.stdin:
    request=json.loads(line); method=request.get('method'); identity=request.get('id'); params=request.get('params') or {}
    if identity is None: continue
    if method=='server/discover':
        response={'error':{'code':-32601,'message':'legacy'}}
    elif method=='initialize':
        response={'result':{'protocolVersion':params['protocolVersion'],'serverInfo':{'name':'fixture','version':'1'},'capabilities':{'tools':{}} if os.environ.get('NO_RESOURCES') else {'tools':{},'resources':{}}}}
    elif method=='tools/list': response={'result':{'tools':[{'name':'echo','description':'Fixture tool','inputSchema':{'type':'object'}}]}}
    elif method=='resources/list':
        if os.environ.get('FAIL_CATALOG'): response={'error':{'code':-32603,'message':'fixture catalog failure'}}
        elif params.get('cursor')=='page-two': response={'result':{'resources':[{'name':'alpha','uri':'fixture:a','description':'second','mimeType':'text/plain'}]}}
        else: response={'result':{'resources':[{'name':'Bravo','uri':'fixture:z','ignored':'private-extra'}],'nextCursor':'page-two'}}
    elif method=='resources/templates/list':
        if params.get('cursor')=='template-next': response={'result':{'resourceTemplates':[{'name':'First','uriTemplate':'fixture:first/{id}'}]}}
        else: response={'result':{'resourceTemplates':[{'name':'Template','uriTemplate':'fixture:{id}'}],'nextCursor':'template-next'}}
    else: response={'error':{'code':-32601,'message':'unknown'}}
    print(json.dumps({'jsonrpc':'2.0','id':identity,**response}),flush=True)
"#;

fn mcp_config(fixture: &Fixture, disabled: bool, fail: bool) -> v5::McpAddRequestPayloadConfig {
    let script = fixture.root.join("mcp.py");
    std::fs::write(&script, MCP_SCRIPT).unwrap();
    v5::McpAddRequestPayloadConfig {
        kind: Some(v5::mcp_add_request_payload_config::Kind::Value1(
            v5::McpLocalConfig {
                r#type: 1,
                command: v5::McpLocalConfigCommand {
                    items: vec![text("/usr/bin/python3"), text(script.to_str().unwrap())],
                },
                cwd: Some(text(".")),
                environment: Some(v5::McpLocalConfigEnvironment {
                    entries: if fail {
                        vec![v5::McpLocalConfigEnvironmentEntry {
                            key: text("FAIL_CATALOG"),
                            value: text("1"),
                        }]
                    } else {
                        vec![]
                    },
                }),
                disabled: Some(disabled),
                codemode: Some(true),
                timeout: Some(v5::McpTimeoutConfig {
                    startup: Some(2000),
                    catalog: Some(1000),
                    execution: Some(1000),
                }),
            },
        )),
    }
}
async fn mcp_add(client: &mut Client, name: &str, config: v5::McpAddRequestPayloadConfig) {
    let _: v5::McpAddResult = ask(
        client,
        "mcp.add",
        location_scope(DIRECTORY),
        v5::McpAddRequest {
            params: v5::McpAddRequestParams { server: text(name) },
            query: query(DIRECTORY, None),
            payload: v5::McpAddRequestPayload { config },
        },
    )
    .await;
}
async fn mcp_list(client: &mut Client) -> Vec<v5::McpServer> {
    let result: v5::McpListResult = ask(
        client,
        "mcp.list",
        location_scope(DIRECTORY),
        v5::McpListRequest {
            query: query(DIRECTORY, None),
        },
    )
    .await;
    result.data.items
}
async fn catalog(client: &mut Client) -> v5::McpResourceCatalog {
    let result: v5::McpResourceCatalogResult = ask(
        client,
        "mcp.resource.catalog",
        location_scope(DIRECTORY),
        v5::McpResourceCatalogRequest {
            query: query(DIRECTORY, None),
        },
    )
    .await;
    result.data
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_shared_manager_runtime_lifecycle_paging_catalog_failures_and_not_found() {
    let fixture = Fixture::new();
    let (server, mut client) = fixture.open().await;
    mcp_add(&mut client, "dynamic", mcp_config(&fixture, true, false)).await;
    assert!(matches!(
        mcp_list(&mut client).await[0].status.kind,
        Some(v5::mcp_server_status::Kind::Value3(_))
    ));
    assert!(fixture.mcp.tools().await.unwrap().is_empty());
    let _: v5::McpConnectResult = ask(
        &mut client,
        "mcp.connect",
        location_scope(DIRECTORY),
        v5::McpConnectRequest {
            params: v5::McpConnectRequestParams {
                server: text("dynamic"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert!(matches!(
        mcp_list(&mut client).await[0].status.kind,
        Some(v5::mcp_server_status::Kind::Value1(_))
    ));
    let tools = fixture.mcp.tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].codemode, Some(true));
    let resources = catalog(&mut client).await;
    assert_eq!(
        resources
            .resources
            .items
            .iter()
            .map(|resource| units(&resource.name))
            .collect::<Vec<_>>(),
        ["alpha", "Bravo"]
    );
    assert_eq!(
        resources
            .templates
            .items
            .iter()
            .map(|template| units(&template.name))
            .collect::<Vec<_>>(),
        ["First", "Template"]
    );
    assert_eq!(
        units(resources.resources.items[0].description.as_ref().unwrap()),
        "second"
    );
    assert!(!format!("{resources:?}").contains("private-extra"));
    let _: v5::McpDisconnectResult = ask(
        &mut client,
        "mcp.disconnect",
        location_scope(DIRECTORY),
        v5::McpDisconnectRequest {
            params: v5::McpDisconnectRequestParams {
                server: text("dynamic"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert!(fixture.mcp.tools().await.unwrap().is_empty());
    assert!(catalog(&mut client).await.resources.items.is_empty());
    mcp_add(&mut client, "dynamic", mcp_config(&fixture, false, true)).await;
    let resources = catalog(&mut client).await;
    assert!(resources.resources.items.is_empty());
    assert_eq!(resources.templates.items.len(), 2);
    let mut no_resources = mcp_config(&fixture, false, false);
    let Some(v5::mcp_add_request_payload_config::Kind::Value1(config)) = &mut no_resources.kind
    else {
        panic!("local config")
    };
    config
        .environment
        .as_mut()
        .unwrap()
        .entries
        .push(v5::McpLocalConfigEnvironmentEntry {
            key: text("NO_RESOURCES"),
            value: text("1"),
        });
    mcp_add(&mut client, "dynamic", no_resources).await;
    let resources = catalog(&mut client).await;
    assert!(resources.resources.items.is_empty());
    assert!(resources.templates.items.is_empty());
    let _: v5::McpRemoveResult = ask(
        &mut client,
        "mcp.remove",
        location_scope(DIRECTORY),
        v5::McpRemoveRequest {
            params: v5::McpRemoveRequestParams {
                server: text("dynamic"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert!(mcp_list(&mut client).await.is_empty());
    assert!(fixture.mcp.tools().await.unwrap().is_empty());
    let removed: v5::McpServerNotFoundError = refuse(
        &mut client,
        "mcp.remove",
        location_scope(DIRECTORY),
        v5::McpRemoveRequest {
            params: v5::McpRemoveRequestParams {
                server: text("dynamic"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert_eq!(units(&removed.server), "dynamic");
    assert_eq!(units(&removed.message), "MCP server not found: dynamic");
    let _: v5::McpServerNotFoundError = refuse(
        &mut client,
        "mcp.connect",
        location_scope(DIRECTORY),
        v5::McpConnectRequest {
            params: v5::McpConnectRequestParams {
                server: text("missing"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    let _: v5::McpServerNotFoundError = refuse(
        &mut client,
        "mcp.disconnect",
        location_scope(DIRECTORY),
        v5::McpDisconnectRequest {
            params: v5::McpDisconnectRequestParams {
                server: text("missing"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    let restarted = mcp::Service::new(
        &[],
        fixture.root.clone(),
        "fixture".into(),
        BTreeMap::new(),
        Hooks::default(),
    )
    .unwrap();
    assert!(restarted.servers().unwrap().is_empty());
    restarted.shutdown().await.unwrap();
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_remote_configuration_registers_auth_and_removal_preserves_saved_credentials() {
    let fixture = Fixture::new();
    let http = HttpFixture::new("{}").await;
    let (server, mut client) = fixture.open().await;
    let config = v5::McpAddRequestPayloadConfig {
        kind: Some(v5::mcp_add_request_payload_config::Kind::Value2(
            v5::McpRemoteConfig {
                r#type: 1,
                url: text(&format!("{}/mcp", http.url)),
                headers: Some(v5::McpRemoteConfigHeaders {
                    entries: vec![v5::McpRemoteConfigHeadersEntry {
                        key: text("x-fixture"),
                        value: text("fixture-value"),
                    }],
                }),
                oauth: Some(v5::McpRemoteConfigOauth {
                    kind: Some(v5::mcp_remote_config_oauth::Kind::Value1(
                        v5::McpOAuthConfig {
                            client_id: Some(text("static-client")),
                            client_secret: Some(text("client-secret")),
                            scope: Some(text("tools")),
                            callback_port: Some(32100),
                            redirect_uri: Some(text("http://localhost:32100/callback")),
                        },
                    )),
                }),
                disabled: Some(true),
                codemode: Some(false),
                timeout: Some(v5::McpTimeoutConfig {
                    startup: Some(1000),
                    catalog: Some(2000),
                    execution: Some(3000),
                }),
            },
        )),
    };
    mcp_add(&mut client, "remote", config.clone()).await;
    let servers = mcp_list(&mut client).await;
    let id = units(servers[0].integration_id.as_ref().unwrap());
    assert!(matches!(
        servers[0].status.kind,
        Some(v5::mcp_server_status::Kind::Value3(_))
    ));
    assert!(
        get(&mut client, &id, DIRECTORY)
            .await
            .unwrap()
            .methods
            .items
            .iter()
            .any(|method| matches!(method.kind, Some(v5::integration_method::Kind::Value1(_))))
    );
    assert!(http.requests.lock().unwrap().is_empty());
    fixture
        .credentials
        .create(
            "credential_fixture".into(),
            id.as_str().into(),
            Some("Saved".into()),
            secret(&id),
            1,
        )
        .await
        .unwrap();
    let _: v5::McpRemoveResult = ask(
        &mut client,
        "mcp.remove",
        location_scope(DIRECTORY),
        v5::McpRemoveRequest {
            params: v5::McpRemoveRequestParams {
                server: text("remote"),
            },
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert!(get(&mut client, &id, DIRECTORY).await.is_none());
    assert_eq!(
        fixture.credentials.list(&id.as_str().into()).unwrap().len(),
        1
    );
    mcp_add(&mut client, "remote", config).await;
    assert_eq!(
        units(
            mcp_list(&mut client).await[0]
                .integration_id
                .as_ref()
                .unwrap()
        ),
        id
    );
    assert!(!format!("{:?}", mcp_list(&mut client).await).contains("client-secret"));
    http.close().await;
    fixture.close(server).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_location_resolvers_answer_declared_unavailable_without_constructing_managers() {
    locations_ready();
    let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let error: v5::InvalidRequestError = refuse(
        &mut client,
        "integration.list",
        location_scope(DIRECTORY),
        v5::IntegrationListRequest {
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert_eq!(units(&error.kind.unwrap()), "unavailable");
    let error: v5::InvalidRequestError = refuse(
        &mut client,
        "mcp.list",
        location_scope(DIRECTORY),
        v5::McpListRequest {
            query: query(DIRECTORY, None),
        },
    )
    .await;
    assert_eq!(units(&error.kind.unwrap()), "unavailable");
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unpaired_mcp_name_reports_the_core_representation_dependency_without_lossy_registration() {
    let fixture = Fixture::new();
    let (server, mut client) = fixture.open().await;
    let error: v5::InvalidRequestError = refuse(
        &mut client,
        "mcp.add",
        location_scope(DIRECTORY),
        v5::McpAddRequest {
            params: v5::McpAddRequestParams {
                server: ycoding_protocol::encode_lossless(&[0xd800]),
            },
            query: query(DIRECTORY, None),
            payload: v5::McpAddRequestPayload {
                config: mcp_config(&fixture, true, false),
            },
        },
    )
    .await;
    assert_eq!(units(&error.kind.unwrap()), "unavailable");
    assert_eq!(
        units(&error.message),
        "Core MCP names require scalar strings"
    );
    assert!(fixture.mcp.servers().unwrap().is_empty());
    fixture.close(server).await;
}
