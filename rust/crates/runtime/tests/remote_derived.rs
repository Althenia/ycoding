#[allow(dead_code)]
mod connector_support;
mod remote_derived_support;
mod support;

use connector_support::{Opening, Relay};
use prost::{Message, Name};
use remote_derived_support::{Access, Fixture, Saved, activate, create, message, stop, world};
use std::{
    collections::BTreeSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use support::{machine, operation, session_scope, text, units};
use ycoding_core::{
    resources::auth::integration,
    ycoding_schema::{DomainEncode, JsonValue, ObjectEncoder, parse_json, session},
    ycoding_store::session as tables,
};
use ycoding_protocol::{connection::Budgets, decode_strict, v5};
use ycoding_runtime::{
    Dispatcher, Environment, Settled,
    connector::{Connector, Control, Enrolled, Settings},
    standard,
};

const NAMES: [&str; 16] = [
    "provider.auth.list",
    "provider.auth.key",
    "provider.auth.begin",
    "provider.auth.status",
    "provider.auth.complete",
    "provider.auth.cancel",
    "workspace.list",
    "catalog.get",
    "session.status",
    "session.capturedChanges.list",
    "session.family.activity",
    "session.side-chat.create",
    "session.side-chat.list",
    "session.team.economics",
    "session.team.shell.list",
    "session.team.shell.kill",
];

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}
fn workspace(id: &str) -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Workspace(id.into())),
    }
}
fn target(id: &str) -> v5::ConnectorAuthTarget {
    v5::ConnectorAuthTarget {
        kind: Some(v5::connector_auth_target::Kind::Value1(
            v5::ConnectorAuthTargetValue1 {
                session_id: text(id),
            },
        )),
    }
}
fn workspace_target(id: &v5::LosslessString) -> v5::ConnectorAuthTarget {
    v5::ConnectorAuthTarget {
        kind: Some(v5::connector_auth_target::Kind::Value2(
            v5::ConnectorAuthTargetValue2 {
                workspace: id.clone(),
            },
        )),
    }
}
fn auth_begin(fixture: &Fixture, method: &str) -> v5::ProviderAuthBeginRequest {
    v5::ProviderAuthBeginRequest {
        payload: v5::ProviderAuthBeginRequestPayload {
            target: target(&fixture.root),
            integration_id: text(&fixture.integration),
            method_id: text(method),
            label: text("Work"),
            inputs: v5::ProviderAuthBeginRequestPayloadInputs { entries: vec![] },
        },
    }
}
fn auth_status(fixture: &Fixture, id: &v5::LosslessString) -> v5::ProviderAuthStatusRequest {
    v5::ProviderAuthStatusRequest {
        payload: v5::ProviderAuthStatusRequestPayload {
            target: target(&fixture.root),
            integration_id: text(&fixture.integration),
            attempt_id: id.clone(),
        },
    }
}

fn requests(fixture: &Fixture) -> Vec<(&'static str, v5::Scope, Vec<u8>)> {
    let scope = session_scope(&fixture.root);
    vec![
        (
            NAMES[0],
            global(),
            v5::ProviderAuthListRequest {
                payload: v5::ProviderAuthListRequestPayload {
                    target: target(&fixture.root),
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[1],
            global(),
            v5::ProviderAuthKeyRequest {
                payload: v5::ProviderAuthKeyRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    label: text("Work"),
                    key: text("synthetic-key-secret"),
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[2],
            global(),
            auth_begin(fixture, "code").encode_to_vec(),
        ),
        (
            NAMES[3],
            global(),
            auth_status(fixture, &text("con_missing")).encode_to_vec(),
        ),
        (
            NAMES[4],
            global(),
            v5::ProviderAuthCompleteRequest {
                payload: v5::ProviderAuthCompleteRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: text("con_missing"),
                    code: text("finish"),
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[5],
            global(),
            v5::ProviderAuthCancelRequest {
                payload: v5::ProviderAuthCancelRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: text("con_missing"),
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[6],
            machine(),
            v5::WorkspaceListRequest {
                payload: v5::WorkspaceListRequestPayload {
                    sessions_only: None,
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[7],
            scope.clone(),
            v5::CatalogGetRequest {}.encode_to_vec(),
        ),
        (
            NAMES[8],
            machine(),
            v5::SessionStatusRequest {}.encode_to_vec(),
        ),
        (
            NAMES[9],
            scope.clone(),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload { cursor: None },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[10],
            scope.clone(),
            v5::SessionFamilyActivityRequest {
                payload: v5::SessionFamilyActivityRequestPayload {
                    session_i_ds: v5::SessionFamilyActivityRequestPayloadSessionIDs {
                        items: vec![text(&fixture.child)],
                    },
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[11],
            scope.clone(),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload {
                    id: text(&format!("{}_btw", fixture.root)),
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[12],
            scope.clone(),
            v5::SessionSideChatListRequest {
                payload: v5::SessionSideChatListRequestPayload { cursor: None },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[13],
            scope.clone(),
            v5::SessionTeamEconomicsRequest {
                payload: v5::SessionTeamEconomicsRequestPayload {
                    session_i_ds: v5::SessionTeamEconomicsRequestPayloadSessionIDs {
                        items: vec![text(&fixture.child)],
                    },
                },
            }
            .encode_to_vec(),
        ),
        (
            NAMES[14],
            scope.clone(),
            v5::SessionTeamShellListRequest {}.encode_to_vec(),
        ),
        (
            NAMES[15],
            scope,
            v5::SessionTeamShellKillRequest {
                payload: v5::SessionTeamShellKillRequestPayload {
                    shell_id: text("sh_missing"),
                },
            }
            .encode_to_vec(),
        ),
    ]
}

struct Harness {
    relay: Relay,
    opening: Opening,
    connector: Connector,
    dispatcher: Arc<Dispatcher>,
    environment: Arc<Environment>,
    seen: BTreeSet<String>,
}
impl Harness {
    async fn new(environment: Arc<Environment>) -> Self {
        let mut relay = Relay::start(5, false, Budgets::default()).await;
        let control = Control::load(Arc::new(Saved(AtomicBool::new(false)))).await;
        let settings = Settings::new(
            Enrolled::new(&relay.origin(), "owner-a".into(), "device-a".into()).unwrap(),
            relay.origin(),
            Arc::new(Access),
        )
        .unwrap();
        let dispatcher = Arc::new(standard().unwrap());
        let connector = Connector::start(
            control.clone(),
            settings,
            environment.clone(),
            dispatcher.clone(),
        )
        .unwrap();
        control.set(true).await.unwrap();
        let opening = relay.opening().await;
        let mut observe = control.observe();
        tokio::time::timeout(
            connector_support::WAIT,
            observe.wait_for(|(_, state)| state.state == ycoding_runtime::connector::State::On),
        )
        .await
        .unwrap()
        .unwrap();
        Self {
            relay,
            opening,
            connector,
            dispatcher,
            environment,
            seen: BTreeSet::new(),
        }
    }
    async fn payload(
        &mut self,
        name: &str,
        scope: v5::Scope,
        payload: Vec<u8>,
    ) -> v5::TypedPayload {
        let id = self
            .opening
            .request(operation(name).operation_id, scope, payload)
            .await;
        let frame = self.relay.matching(self.opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id) || matches!(&frame.body, Some(v5::frame::Body::BulkStart(start)) if start.request_id == id)).await;
        match frame.body.unwrap() {
            v5::frame::Body::Result(result) => match result.outcome.unwrap() {
                v5::result::Outcome::Success(value) => {
                    self.seen.insert(name.into());
                    value
                }
                v5::result::Outcome::Error(value) => value,
                v5::result::Outcome::AssetMetadata(_) => {
                    panic!("remote-derived operation must return typed data")
                }
            },
            v5::frame::Body::BulkStart(start) => {
                let mut body = Vec::new();
                loop {
                    let frame = self.relay.matching(self.opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::BulkPiece(chunk)) if chunk.transfer_id == start.transfer_id) || matches!(&frame.body, Some(v5::frame::Body::BulkEnd(end)) if end.transfer_id == start.transfer_id)).await;
                    match frame.body.unwrap() {
                        v5::frame::Body::BulkPiece(chunk) => {
                            assert_eq!(chunk.offset as usize, body.len());
                            body.extend(chunk.data);
                        }
                        v5::frame::Body::BulkEnd(_) => break,
                        _ => unreachable!(),
                    }
                }
                self.seen.insert(name.into());
                v5::TypedPayload {
                    type_name: start.type_name,
                    payload: body,
                }
            }
            _ => panic!("expected settlement"),
        }
    }
    async fn ask<Q: Message, T: Message + Name + Default>(
        &mut self,
        name: &str,
        scope: v5::Scope,
        request: Q,
    ) -> T {
        let payload = self.payload(name, scope, request.encode_to_vec()).await;
        if payload.type_name == v5::ConnectorError::full_name() {
            let error = decode_strict::<v5::ConnectorError>(&payload.payload).unwrap();
            panic!("{name} rejected: {} {}", error.code, units(&error.message));
        }
        assert_eq!(payload.type_name, T::full_name(), "{name}");
        ycoding_protocol::validate_binary(&payload.type_name, &payload.payload).unwrap();
        decode_strict(&payload.payload).unwrap()
    }
    async fn refuse<Q: Message>(&mut self, name: &str, scope: v5::Scope, request: Q, code: i32) {
        let payload = self.payload(name, scope, request.encode_to_vec()).await;
        assert!(operation(name).error_types.contains(&payload.type_name));
        assert_eq!(payload.type_name, v5::ConnectorError::full_name());
        assert_eq!(
            decode_strict::<v5::ConnectorError>(&payload.payload)
                .unwrap()
                .code,
            code,
            "{name}"
        );
    }
    async fn close(self) {
        self.connector.shutdown().await.unwrap();
        self.relay.shutdown().await;
    }
}

fn no_private(bytes: &[u8]) {
    for private in [
        "synthetic-key-secret",
        "synthetic-env-secret",
        "synthetic-provider-secret",
        "synthetic-access-secret",
        "synthetic-refresh-secret",
        "credentialID",
        "accountEmail",
        "Authorization",
    ] {
        assert!(
            !bytes
                .windows(private.len())
                .any(|window| window == private.as_bytes()),
            "leaked {private}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn all_16_successes_cross_real_connector_and_reject_expired_owner_authority() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    for (name, scope, payload) in requests(&fixture) {
        let result = harness
            .dispatcher
            .invoke_remote(
                harness.environment.clone(),
                "expired-owner".into(),
                &remote_derived_support::expired_peer(),
                v5::Request {
                    request_id: "expired".into(),
                    operation_id: operation(name).operation_id,
                    scope,
                    payload,
                },
            )
            .await;
        let Some(Settled::Result(result)) = result else {
            panic!("missing settlement for {name}");
        };
        let Some(v5::result::Outcome::Error(error)) = result.outcome else {
            panic!("unauthorized success for {name}");
        };
        assert_eq!(error.type_name, v5::ConnectorError::full_name());
        assert_eq!(
            decode_strict::<v5::ConnectorError>(&error.payload)
                .unwrap()
                .code,
            14,
            "{name}"
        );
    }
    let offered: v5::ProviderAuthListResult = harness
        .ask(
            NAMES[0],
            global(),
            v5::ProviderAuthListRequest {
                payload: v5::ProviderAuthListRequestPayload {
                    target: target(&fixture.root),
                },
            },
        )
        .await;
    assert_eq!(offered.data.items.len(), 1);
    assert_eq!(offered.data.items[0].methods.items.len(), 5);
    assert!(
        !offered.data.items[0]
            .methods
            .items
            .iter()
            .find(|method| method.id.as_ref().is_some_and(|id| units(id) == "backend"))
            .unwrap()
            .available
    );
    no_private(&offered.encode_to_vec());
    let key: v5::ProviderAuthKeyResult = harness
        .ask(
            NAMES[1],
            global(),
            v5::ProviderAuthKeyRequest {
                payload: v5::ProviderAuthKeyRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    label: text("Work"),
                    key: text("synthetic-key-secret"),
                },
            },
        )
        .await;
    assert_eq!(key.data.status, 1);
    let begin: v5::ProviderAuthBeginResult = harness
        .ask(NAMES[2], global(), auth_begin(&fixture, "code"))
        .await;
    assert_eq!(begin.data.r#type, 1);
    assert_eq!(begin.data.mode, Some(2));
    no_private(&begin.encode_to_vec());
    let status: v5::ProviderAuthStatusResult = harness
        .ask(
            NAMES[3],
            global(),
            auth_status(&fixture, &begin.data.attempt_id),
        )
        .await;
    assert_eq!(status.data.status, 1);
    let complete: v5::ProviderAuthCompleteResult = harness
        .ask(
            NAMES[4],
            global(),
            v5::ProviderAuthCompleteRequest {
                payload: v5::ProviderAuthCompleteRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: begin.data.attempt_id.clone(),
                    code: text("finish"),
                },
            },
        )
        .await;
    assert_eq!(complete.data.status, 1);
    let status: v5::ProviderAuthStatusResult = harness
        .ask(
            NAMES[3],
            global(),
            auth_status(&fixture, &begin.data.attempt_id),
        )
        .await;
    assert_eq!(status.data.status, 2);
    no_private(&status.encode_to_vec());
    let cancel: v5::ProviderAuthCancelResult = harness
        .ask(
            NAMES[5],
            global(),
            v5::ProviderAuthCancelRequest {
                payload: v5::ProviderAuthCancelRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: begin.data.attempt_id,
                },
            },
        )
        .await;
    assert_eq!(cancel.data.status, 1);
    let workspaces: v5::WorkspaceListResult = harness
        .ask(
            NAMES[6],
            machine(),
            v5::WorkspaceListRequest {
                payload: v5::WorkspaceListRequestPayload {
                    sessions_only: None,
                },
            },
        )
        .await;
    let entry = workspaces
        .data
        .items
        .iter()
        .find(|workspace| units(&workspace.directory) == fixture.directory)
        .unwrap();
    assert!(units(&entry.id).starts_with("wsp_"));
    let catalog: v5::CatalogGetResult = harness
        .ask(
            NAMES[7],
            session_scope(&fixture.root),
            v5::CatalogGetRequest {},
        )
        .await;
    assert_eq!(catalog.data.models.items.len(), 1);
    assert_eq!(units(&catalog.data.models.items[0].id), "code");
    no_private(&catalog.encode_to_vec());
    let by_workspace: v5::CatalogGetResult = harness
        .ask(
            NAMES[7],
            workspace(&units(&entry.id)),
            v5::CatalogGetRequest {},
        )
        .await;
    assert_eq!(by_workspace, catalog);
    let _: v5::SessionStatusResult = harness
        .ask(NAMES[8], machine(), v5::SessionStatusRequest {})
        .await;
    let captured: v5::SessionCapturedChangesListResult = harness
        .ask(
            NAMES[9],
            session_scope(&fixture.root),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload { cursor: None },
            },
        )
        .await;
    assert!(captured.data.items.is_empty());
    let activity: v5::SessionFamilyActivityResult = harness
        .ask(
            NAMES[10],
            session_scope(&fixture.root),
            v5::SessionFamilyActivityRequest {
                payload: v5::SessionFamilyActivityRequestPayload {
                    session_i_ds: v5::SessionFamilyActivityRequestPayloadSessionIDs {
                        items: vec![text(&fixture.child)],
                    },
                },
            },
        )
        .await;
    assert_eq!(activity.data.items.len(), 2);
    assert!(
        activity
            .data
            .items
            .iter()
            .all(|member| !member.executing && member.activity.is_none())
    );
    let btw = format!("{}_btw", fixture.root);
    let created: v5::SessionSideChatCreateResult = harness
        .ask(
            NAMES[11],
            session_scope(&fixture.root),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload { id: text(&btw) },
            },
        )
        .await;
    assert_eq!(units(created.data.agent.as_ref().unwrap()), "btw");
    assert_eq!(
        units(created.data.parent_id.as_ref().unwrap()),
        fixture.root
    );
    let chats: v5::SessionSideChatListResult = harness
        .ask(
            NAMES[12],
            session_scope(&fixture.root),
            v5::SessionSideChatListRequest {
                payload: v5::SessionSideChatListRequestPayload { cursor: None },
            },
        )
        .await;
    assert_eq!(chats.data.items.len(), 1);
    assert_eq!(units(&chats.data.items[0].id), btw);
    let economics: v5::SessionTeamEconomicsResult = harness
        .ask(
            NAMES[13],
            session_scope(&fixture.root),
            v5::SessionTeamEconomicsRequest {
                payload: v5::SessionTeamEconomicsRequestPayload {
                    session_i_ds: v5::SessionTeamEconomicsRequestPayloadSessionIDs {
                        items: vec![text(&fixture.child)],
                    },
                },
            },
        )
        .await;
    assert_eq!(economics.data.items.len(), 1);
    assert!(economics.data.items[0].cache_read.is_none());
    assert!(economics.data.items[0].cache_write.is_none());
    let shell = remote_derived_support::owned_shell(
        &fixture.child_platform,
        Some(&fixture.child),
        "sleep 30",
    )
    .await;
    let list: v5::SessionTeamShellListResult = harness
        .ask(
            NAMES[14],
            session_scope(&fixture.root),
            v5::SessionTeamShellListRequest {},
        )
        .await;
    assert!(!list.truncated);
    assert_eq!(list.data.items.len(), 1);
    assert_eq!(units(&list.data.items[0].owner_id), fixture.child);
    let id = match shell.id.encode() {
        JsonValue::String(id) => id,
        _ => unreachable!(),
    };
    let _: v5::SessionTeamShellKillResult = harness
        .ask(
            NAMES[15],
            session_scope(&fixture.root),
            v5::SessionTeamShellKillRequest {
                payload: v5::SessionTeamShellKillRequestPayload {
                    shell_id: text(id.as_str().unwrap()),
                },
            },
        )
        .await;
    assert!(fixture.child_platform.shell.get(&shell.id).await.is_err());
    assert_eq!(harness.seen, NAMES.into_iter().map(String::from).collect());
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn all_16_missing_backend_failures_are_descriptor_typed_over_the_connector() {
    let fixture = Fixture::new().await;
    let tables = ycoding_core::ycoding_store::session::TABLES
        .iter()
        .chain(ycoding_core::ycoding_store::project::TABLES)
        .copied()
        .collect::<Vec<_>>();
    let store = ycoding_core::ycoding_store::Store::disposable(
        ycoding_core::ycoding_store::Options::core(),
        ycoding_core::ycoding_store::Catalog::new(1, Box::leak(tables.into_boxed_slice())),
        ycoding_core::ycoding_store::Metadata::new([39; 16], 1),
    )
    .unwrap();
    let mut environment = fixture.environment(true);
    Arc::get_mut(&mut environment)
        .unwrap()
        .services
        .core
        .as_mut()
        .unwrap()
        .sessions = ycoding_core::session::store::Service::new(store.client());
    let mut harness = Harness::new(environment).await;
    store.shutdown().unwrap();
    for (name, scope, payload) in requests(&fixture) {
        let error = harness.payload(name, scope, payload).await;
        assert!(operation(name).error_types.contains(&error.type_name));
        assert_eq!(
            decode_strict::<v5::ConnectorError>(&error.payload)
                .unwrap()
                .code,
            10,
            "{name}"
        );
        no_private(&error.payload);
    }
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn authentication_validates_offers_prompts_links_attempt_binding_and_capacity() {
    let mut fixture = Fixture::new().await;
    fixture.oauth(
        "prompt",
        true,
        "https://auth.invalid/authorize",
        Some(vec![
            ycoding_core::ycoding_schema::integration::Prompt::Select(
                ycoding_core::ycoding_schema::integration::SelectPrompt {
                    key: "choice".into(),
                    message: "Choose".into(),
                    options: vec![ycoding_core::ycoding_schema::integration::SelectOption {
                        label: "Work".into(),
                        value: "work".into(),
                        hint: None,
                    }],
                    when: None,
                },
            ),
        ]),
        false,
    );
    let mut harness = Harness::new(fixture.environment(true)).await;
    harness
        .refuse(NAMES[2], global(), auth_begin(&fixture, "backend"), 1)
        .await;
    harness
        .refuse(NAMES[2], global(), auth_begin(&fixture, "missing"), 1)
        .await;
    harness
        .refuse(NAMES[2], global(), auth_begin(&fixture, "prompt"), 1)
        .await;
    assert_eq!(fixture.calls.load(Ordering::Acquire), 0);
    let mut unknown = auth_begin(&fixture, "code");
    unknown
        .payload
        .inputs
        .entries
        .push(v5::ProviderAuthBeginRequestPayloadInputsEntry {
            key: text("unknown"),
            value: text("value"),
        });
    harness.refuse(NAMES[2], global(), unknown, 1).await;
    assert_eq!(fixture.calls.load(Ordering::Acquire), 0);
    harness
        .refuse(NAMES[2], global(), auth_begin(&fixture, "unsafe"), 1)
        .await;
    let mut choice = auth_begin(&fixture, "prompt");
    choice
        .payload
        .inputs
        .entries
        .push(v5::ProviderAuthBeginRequestPayloadInputsEntry {
            key: text("choice"),
            value: text("wrong"),
        });
    harness.refuse(NAMES[2], global(), choice.clone(), 1).await;
    choice.payload.inputs.entries[0].value = text("work");
    let valid: v5::ProviderAuthBeginResult = harness.ask(NAMES[2], global(), choice).await;
    let mut wrong_target = auth_status(&fixture, &valid.data.attempt_id);
    wrong_target.payload.target = target(&fixture.other);
    harness.refuse(NAMES[3], global(), wrong_target, 1).await;
    let mut wrong_integration = auth_status(&fixture, &valid.data.attempt_id);
    wrong_integration.payload.integration_id = text("not-offered");
    harness
        .refuse(NAMES[3], global(), wrong_integration, 1)
        .await;
    let mut second = Harness::new(fixture.environment(true)).await;
    second
        .refuse(
            NAMES[3],
            global(),
            auth_status(&fixture, &valid.data.attempt_id),
            1,
        )
        .await;
    second.close().await;
    let _: v5::ProviderAuthCancelResult = harness
        .ask(
            NAMES[5],
            global(),
            v5::ProviderAuthCancelRequest {
                payload: v5::ProviderAuthCancelRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: valid.data.attempt_id.clone(),
                },
            },
        )
        .await;
    harness
        .refuse(
            NAMES[3],
            global(),
            auth_status(&fixture, &valid.data.attempt_id),
            1,
        )
        .await;
    let failed: v5::ProviderAuthBeginResult = harness
        .ask(NAMES[2], global(), auth_begin(&fixture, "failed"))
        .await;
    harness
        .refuse(
            NAMES[4],
            global(),
            v5::ProviderAuthCompleteRequest {
                payload: v5::ProviderAuthCompleteRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: failed.data.attempt_id.clone(),
                    code: text("finish"),
                },
            },
            1,
        )
        .await;
    let failure: v5::ProviderAuthStatusResult = harness
        .ask(
            NAMES[3],
            global(),
            auth_status(&fixture, &failed.data.attempt_id),
        )
        .await;
    assert_eq!(failure.data.status, 3);
    assert_eq!(
        units(failure.data.message.as_ref().unwrap()),
        "Authentication failed. Try connecting again."
    );
    no_private(&failure.encode_to_vec());
    let _: v5::ProviderAuthCancelResult = harness
        .ask(
            NAMES[5],
            global(),
            v5::ProviderAuthCancelRequest {
                payload: v5::ProviderAuthCancelRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: failed.data.attempt_id,
                },
            },
        )
        .await;
    let mut ids = Vec::new();
    for _ in 0..32 {
        let attempt: v5::ProviderAuthBeginResult = harness
            .ask(NAMES[2], global(), auth_begin(&fixture, "code"))
            .await;
        ids.push(attempt.data.attempt_id);
    }
    harness
        .refuse(NAMES[2], global(), auth_begin(&fixture, "code"), 1)
        .await;
    let _: v5::ProviderAuthCancelResult = harness
        .ask(
            NAMES[5],
            global(),
            v5::ProviderAuthCancelRequest {
                payload: v5::ProviderAuthCancelRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: ids.pop().unwrap(),
                },
            },
        )
        .await;
    let _: v5::ProviderAuthBeginResult = harness
        .ask(NAMES[2], global(), auth_begin(&fixture, "code"))
        .await;
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn advertised_workspaces_are_backend_derived_and_revalidated_before_catalog_or_auth() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    let full: v5::WorkspaceListResult = harness
        .ask(
            NAMES[6],
            machine(),
            v5::WorkspaceListRequest {
                payload: v5::WorkspaceListRequestPayload {
                    sessions_only: None,
                },
            },
        )
        .await;
    let entry = full
        .data
        .items
        .iter()
        .find(|entry| units(&entry.directory) == fixture.directory)
        .unwrap();
    let expected = format!(
        "wsp_{}",
        ycoding_core::session::prompt_cache::sha256(&format!(
            "ycoding.remote.workspace.v1\0{}",
            ycoding_core::ycoding_schema::stringify_json(&JsonValue::Array(vec![
                JsonValue::String(fixture.project.as_str().into()),
                JsonValue::String(fixture.directory.as_str().into()),
                JsonValue::Null
            ]))
        ))
    );
    assert_eq!(units(&entry.id), expected);
    let auth: v5::ProviderAuthListResult = harness
        .ask(
            NAMES[0],
            global(),
            v5::ProviderAuthListRequest {
                payload: v5::ProviderAuthListRequestPayload {
                    target: workspace_target(&entry.id),
                },
            },
        )
        .await;
    assert_eq!(auth.data.items.len(), 1);
    harness
        .refuse(
            NAMES[7],
            workspace(&fixture.directory),
            v5::CatalogGetRequest {},
            1,
        )
        .await;
    harness
        .refuse(
            NAMES[0],
            global(),
            v5::ProviderAuthListRequest {
                payload: v5::ProviderAuthListRequestPayload {
                    target: workspace_target(&text(&fixture.directory)),
                },
            },
            1,
        )
        .await;
    let isolated = Fixture::new().await;
    let id = isolated.root.clone();
    let directory = std::env::temp_dir().to_str().unwrap().to_owned();
    world()
        .store
        .submit(move |tx| {
            let mut row = tx
                .get::<tables::SessionTable>(&ycoding_core::ycoding_store::tuple_key(&[
                    ycoding_core::ycoding_store::KeyPart::String(&id.as_str().into()),
                ]))?
                .unwrap();
            row.directory = directory.as_str().into();
            tx.put::<tables::SessionTable>(&row)
        })
        .unwrap()
        .await
        .unwrap();
    let groups: v5::WorkspaceListResult = harness
        .ask(
            NAMES[6],
            machine(),
            v5::WorkspaceListRequest {
                payload: v5::WorkspaceListRequestPayload {
                    sessions_only: Some(true),
                },
            },
        )
        .await;
    assert!(
        !groups
            .data
            .items
            .iter()
            .any(|entry| units(&entry.directory) == std::env::temp_dir().to_str().unwrap())
    );
    std::fs::rename(&fixture.path, fixture.path.with_extension("moved")).unwrap();
    harness
        .refuse(NAMES[7], workspace(&expected), v5::CatalogGetRequest {}, 1)
        .await;
    harness
        .refuse(
            NAMES[0],
            global(),
            v5::ProviderAuthListRequest {
                payload: v5::ProviderAuthListRequestPayload {
                    target: target(&fixture.root),
                },
            },
            5,
        )
        .await;
    std::fs::rename(fixture.path.with_extension("moved"), &fixture.path).unwrap();
    harness.close().await;
    isolated.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_family_side_chats_reuse_ids_admit_context_and_reject_foreign_or_deleted_members() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    message(
        &fixture.root,
        "parent",
        "user",
        2,
        r#"{"text":"Parent task","time":{"created":2,"consumed":2}}"#,
    )
    .await;
    let btw = format!("{}_btw", fixture.root);
    let first: v5::SessionSideChatCreateResult = harness
        .ask(
            NAMES[11],
            session_scope(&fixture.root),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload { id: text(&btw) },
            },
        )
        .await;
    let second: v5::SessionSideChatCreateResult = harness
        .ask(
            NAMES[11],
            session_scope(&fixture.root),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload { id: text(&btw) },
            },
        )
        .await;
    assert_eq!(first.data.id, second.data.id);
    let pending = world()
        .core
        .sessions
        .pending_list(&session::Id::new(btw.as_str()).unwrap())
        .unwrap();
    assert_eq!(pending.len(), 1);
    let encoded =
        ycoding_core::ycoding_schema::stringify_json(&pending[0].info().unwrap().encode());
    assert!(encoded.contains("Parent task"));
    assert!(
        !world()
            .core
            .execution
            .active()
            .contains(&session::Id::new(btw.as_str()).unwrap())
    );
    harness
        .refuse(
            NAMES[11],
            session_scope(&fixture.root),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload {
                    id: text(&fixture.other),
                },
            },
            1,
        )
        .await;
    harness
        .refuse(
            NAMES[11],
            session_scope(&fixture.child),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload {
                    id: text(&format!("{}_bad", fixture.root)),
                },
            },
            12,
        )
        .await;
    harness
        .refuse(
            NAMES[12],
            session_scope(&fixture.child),
            v5::SessionSideChatListRequest {
                payload: v5::SessionSideChatListRequestPayload { cursor: None },
            },
            12,
        )
        .await;
    for id in [&fixture.other, &btw] {
        harness
            .refuse(
                NAMES[13],
                session_scope(&fixture.root),
                v5::SessionTeamEconomicsRequest {
                    payload: v5::SessionTeamEconomicsRequestPayload {
                        session_i_ds: v5::SessionTeamEconomicsRequestPayloadSessionIDs {
                            items: vec![text(id)],
                        },
                    },
                },
                12,
            )
            .await;
    }
    harness
        .refuse(
            NAMES[10],
            session_scope(&fixture.root),
            v5::SessionFamilyActivityRequest {
                payload: v5::SessionFamilyActivityRequestPayload {
                    session_i_ds: v5::SessionFamilyActivityRequestPayloadSessionIDs {
                        items: vec![text(&fixture.other)],
                    },
                },
            },
            5,
        )
        .await;
    let other = format!("{}_another", fixture.root);
    create(&other, &fixture.project, &fixture.directory, None, "build").await;
    let chats: v5::SessionSideChatListResult = harness
        .ask(
            NAMES[12],
            session_scope(&fixture.root),
            v5::SessionSideChatListRequest {
                payload: v5::SessionSideChatListRequestPayload { cursor: None },
            },
        )
        .await;
    harness
        .refuse(
            NAMES[12],
            session_scope(&other),
            v5::SessionSideChatListRequest {
                payload: v5::SessionSideChatListRequestPayload {
                    cursor: chats.cursor.next,
                },
            },
            1,
        )
        .await;
    world()
        .core
        .sessions
        .remove(&session::Id::new(fixture.child.as_str()).unwrap())
        .await
        .unwrap();
    harness
        .refuse(
            NAMES[13],
            session_scope(&fixture.root),
            v5::SessionTeamEconomicsRequest {
                payload: v5::SessionTeamEconomicsRequestPayload {
                    session_i_ds: v5::SessionTeamEconomicsRequestPayloadSessionIDs {
                        items: vec![text(&fixture.child)],
                    },
                },
            },
            5,
        )
        .await;
    harness
        .refuse(
            NAMES[9],
            session_scope(&fixture.child),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload { cursor: None },
            },
            5,
        )
        .await;
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn family_shells_use_recorded_locations_filter_foreign_owners_and_fail_closed_before_kill() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    let owned =
        remote_derived_support::owned_shell(&fixture.platform, Some(&fixture.root), "sleep 30")
            .await;
    let foreign =
        remote_derived_support::owned_shell(&fixture.platform, Some(&fixture.other), "sleep 30")
            .await;
    let ownerless = remote_derived_support::owned_shell(&fixture.platform, None, "sleep 30").await;
    let misplaced =
        remote_derived_support::owned_shell(&fixture.platform, Some(&fixture.child), "sleep 30")
            .await;
    let list: v5::SessionTeamShellListResult = harness
        .ask(
            NAMES[14],
            session_scope(&fixture.root),
            v5::SessionTeamShellListRequest {},
        )
        .await;
    assert_eq!(list.data.items.len(), 1);
    assert_eq!(units(&list.data.items[0].owner_id), fixture.root);
    for shell in [&foreign, &ownerless, &misplaced] {
        let JsonValue::String(id) = shell.id.encode() else {
            unreachable!()
        };
        harness
            .refuse(
                NAMES[15],
                session_scope(&fixture.root),
                v5::SessionTeamShellKillRequest {
                    payload: v5::SessionTeamShellKillRequestPayload {
                        shell_id: text(id.as_str().unwrap()),
                    },
                },
                12,
            )
            .await;
        assert!(fixture.platform.shell.get(&shell.id).await.is_ok());
    }
    harness
        .refuse(
            NAMES[14],
            session_scope(&fixture.child),
            v5::SessionTeamShellListRequest {},
            12,
        )
        .await;
    harness
        .refuse(
            NAMES[15],
            session_scope(&fixture.root),
            v5::SessionTeamShellKillRequest {
                payload: v5::SessionTeamShellKillRequestPayload {
                    shell_id: text("sh_missing"),
                },
            },
            7,
        )
        .await;
    let JsonValue::String(id) = owned.id.encode() else {
        unreachable!()
    };
    let _: v5::SessionTeamShellKillResult = harness
        .ask(
            NAMES[15],
            session_scope(&fixture.root),
            v5::SessionTeamShellKillRequest {
                payload: v5::SessionTeamShellKillRequestPayload {
                    shell_id: text(id.as_str().unwrap()),
                },
            },
        )
        .await;
    harness.close().await;
    fixture.close().await;
}

fn assistant(content: JsonValue, completed: bool) -> String {
    ycoding_core::ycoding_schema::stringify_json(
        &ObjectEncoder::new()
            .field("agent", "build")
            .field(
                "model",
                &parse_json(r#"{"providerID":"fixture","id":"code"}"#).unwrap(),
            )
            .field("content", &content)
            .field(
                "time",
                &if completed {
                    parse_json(r#"{"created":2,"completed":2}"#).unwrap()
                } else {
                    parse_json(r#"{"created":2}"#).unwrap()
                },
            )
            .finish(),
    )
}
fn patch_tool(path: &str) -> JsonValue {
    parse_json(&format!(r#"{{"type":"tool","id":"patch_call","name":"patch","state":{{"status":"completed","input":{{}},"content":[],"structured":{{"files":[{{"file":"{path}","patch":"--- /dev/null\n+++ b/{path}\n@@ -0,0 +1 @@\n+new\n"}}]}}}},"time":{{"created":1,"completed":2}}}}"#)).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn captured_changes_attribute_parent_launch_send_and_answer_and_bind_stable_pages() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    message(
        &fixture.root,
        "input",
        "user",
        1,
        r#"{"text":"Task","time":{"created":1,"consumed":1}}"#,
    )
    .await;
    let launch = parse_json(&format!(r#"{{"type":"tool","id":"launch","name":"subagent","state":{{"status":"completed","input":{{}},"content":[],"structured":{{"sessionID":"{}"}}}},"time":{{"created":1,"completed":2}}}}"#, fixture.child)).unwrap();
    message(
        &fixture.root,
        "launch",
        "assistant",
        2,
        &assistant(
            JsonValue::Array(vec![patch_tool("parent.txt"), launch]),
            true,
        ),
    )
    .await;
    message(
        &fixture.child,
        "input",
        "user",
        1,
        r#"{"text":"Child task","time":{"created":1,"consumed":1}}"#,
    )
    .await;
    message(
        &fixture.child,
        "launch",
        "assistant",
        2,
        &assistant(JsonValue::Array(vec![patch_tool("child.txt")]), true),
    )
    .await;
    message(
        &fixture.child,
        "next",
        "user",
        3,
        r#"{"text":"Another task","time":{"created":3,"consumed":3}}"#,
    )
    .await;
    message(
        &fixture.child,
        "unclaimed",
        "assistant",
        4,
        &assistant(JsonValue::Array(vec![patch_tool("not-claimed.txt")]), true),
    )
    .await;
    let send = parse_json(&format!(r#"{{"type":"tool","id":"send_call","name":"subagent_control","state":{{"status":"completed","input":{{}},"content":[],"structured":{{"action":"send","task":{{"sessionID":"{}"}}}}}},"time":{{"created":1,"completed":2}}}}"#, fixture.child)).unwrap();
    message(
        &fixture.root,
        "send",
        "assistant",
        3,
        &assistant(JsonValue::Array(vec![send]), true),
    )
    .await;
    let send_id = ycoding_core::session::orchestration::send_message_id(
        &fixture.root,
        &format!("msg_{}_send", fixture.root),
        "send_call",
    );
    let child = fixture.child.clone();
    let send = tables::Message {
        id: send_id.as_lossless().clone(),
        session_id: child.as_str().into(),
        type_: "user".into(),
        seq: 5,
        time_created: 5,
        time_updated: 5,
        data: parse_json(r#"{"text":"Send","time":{"created":5,"consumed":5}}"#).unwrap(),
    };
    world()
        .store
        .submit(move |tx| tables::MessageTable::insert(tx, &send))
        .unwrap()
        .await
        .unwrap();
    message(
        &fixture.child,
        "send",
        "assistant",
        6,
        &assistant(JsonValue::Array(vec![patch_tool("send.txt")]), true),
    )
    .await;
    let answer = parse_json(&format!(r#"{{"type":"tool","id":"answer_call","name":"subagent_control","state":{{"status":"completed","input":{{"questionID":"q_one"}},"content":[],"structured":{{"action":"answer","task":{{"sessionID":"{}"}}}}}},"time":{{"created":1,"completed":2}}}}"#, fixture.child)).unwrap();
    message(
        &fixture.root,
        "answer",
        "assistant",
        4,
        &assistant(JsonValue::Array(vec![answer]), true),
    )
    .await;
    message(&fixture.child, "answer", "synthetic", 7, r#"{"text":"Answer","metadata":{"kind":"answer","questionID":"q_one"},"time":{"created":7}}"#).await;
    message(
        &fixture.child,
        "answer_patch",
        "assistant",
        8,
        &assistant(JsonValue::Array(vec![patch_tool("answer.txt")]), true),
    )
    .await;
    let groups: v5::SessionCapturedChangesListResult = harness
        .ask(
            NAMES[9],
            session_scope(&fixture.root),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload { cursor: None },
            },
        )
        .await;
    assert_eq!(
        groups
            .data
            .items
            .iter()
            .map(|group| units(&group.path))
            .collect::<Vec<_>>(),
        ["parent.txt", "child.txt", "send.txt", "answer.txt"]
    );
    assert!(groups.data.items.iter().all(|group| group.additions == 1
        && group.deletions == 0
        && group.status == 1
        && units(&group.placement_message_id) == format!("msg_{}_answer", fixture.root)));
    let many = (0..101)
        .map(|index| patch_tool(&format!("file{index}.txt")))
        .collect();
    message(
        &fixture.root,
        "many",
        "assistant",
        5,
        &assistant(JsonValue::Array(many), true),
    )
    .await;
    let page: v5::SessionCapturedChangesListResult = harness
        .ask(
            NAMES[9],
            session_scope(&fixture.root),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload { cursor: None },
            },
        )
        .await;
    assert_eq!(page.data.items.len(), 100);
    let cursor = page.cursor.unwrap().next.unwrap();
    let next: v5::SessionCapturedChangesListResult = harness
        .ask(
            NAMES[9],
            session_scope(&fixture.root),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload {
                    cursor: Some(cursor.clone()),
                },
            },
        )
        .await;
    assert_eq!(next.data.items.len(), 5);
    assert!(next.cursor.is_none());
    message(
        &fixture.root,
        "changed",
        "assistant",
        6,
        &assistant(JsonValue::Array(vec![patch_tool("changed.txt")]), true),
    )
    .await;
    harness
        .refuse(
            NAMES[9],
            session_scope(&fixture.root),
            v5::SessionCapturedChangesListRequest {
                payload: v5::SessionCapturedChangesListRequestPayload {
                    cursor: Some(cursor),
                },
            },
            1,
        )
        .await;
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn active_family_summaries_are_sanitized_and_status_projects_roots() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    activate(&fixture.child).await;
    for (index, name, input, room, expected) in [
        (
            1,
            "read",
            r#"{"path":"/private/path/code.ts"}"#,
            1,
            "Reading code.ts",
        ),
        (
            2,
            "grep",
            r#"{"query":"api_key synthetic-private"}"#,
            1,
            "Searching",
        ),
        (
            3,
            "webfetch",
            r#"{"url":"https://person:password@example.invalid/private?q=secret"}"#,
            1,
            "Fetching example.invalid",
        ),
        (
            4,
            "shell",
            r#"{"command":"bun test ./test"}"#,
            2,
            "Running bun test ./test",
        ),
        (5, "subagent", "{}", 3, "Dispatching a subagent"),
        (
            6,
            "patch",
            r#"{"patchText":"*** Update File: /private/path/code.ts\n+safe"}"#,
            4,
            "Editing code.ts",
        ),
    ] {
        let tool = parse_json(&format!(r#"{{"type":"tool","id":"call_{index}","name":"{name}","state":{{"status":"running","input":{input},"structured":{{}},"content":[]}},"time":{{"created":1}}}}"#)).unwrap();
        message(
            &fixture.child,
            &format!("live_{index}"),
            "assistant",
            index + 1,
            &assistant(JsonValue::Array(vec![tool]), false),
        )
        .await;
        let activity: v5::SessionFamilyActivityResult = harness
            .ask(
                NAMES[10],
                session_scope(&fixture.root),
                v5::SessionFamilyActivityRequest {
                    payload: v5::SessionFamilyActivityRequestPayload {
                        session_i_ds: v5::SessionFamilyActivityRequestPayloadSessionIDs {
                            items: vec![text(&fixture.child)],
                        },
                    },
                },
            )
            .await;
        assert!(!activity.data.items[0].executing);
        let child = &activity.data.items[1];
        assert!(child.executing);
        let activity = child.activity.as_ref().unwrap();
        assert_eq!(activity.room, room);
        assert_eq!(units(&activity.text), expected);
    }
    let status: v5::SessionStatusResult = harness
        .ask(NAMES[8], machine(), v5::SessionStatusRequest {})
        .await;
    assert!(
        status
            .running
            .items
            .iter()
            .any(|id| units(id) == fixture.root)
    );
    assert!(
        !status
            .running
            .items
            .iter()
            .any(|id| units(id) == fixture.child)
    );
    stop(&fixture.child).await;
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn command_auth_cancels_and_expired_oauth_attempts_cannot_be_polled() {
    let mut fixture = Fixture::new().await;
    let id = fixture.integration.clone();
    fixture.registrations.push(
        fixture
            .registry
            .transform(move |draft| {
                draft.method(
                    id.as_str().into(),
                    ycoding_core::ycoding_schema::integration::Method::Command(
                        ycoding_core::ycoding_schema::integration::CommandMethod {
                            id: ycoding_core::ycoding_schema::integration::MethodId::new("command")
                                .unwrap(),
                            label: "Command".into(),
                            command: vec!["/bin/sh".into(), "-c".into(), "sleep 30".into()],
                        },
                    ),
                )
            })
            .unwrap(),
    );
    let implementation = integration::OAuthImplementation {
        integration: fixture.integration.as_str().into(),
        method: ycoding_core::ycoding_schema::integration::OAuthMethod {
            id: ycoding_core::ycoding_schema::integration::MethodId::new("expired").unwrap(),
            label: "Expired".into(),
            prompts: None,
            remote: Some(true),
        },
        authorize: Arc::new(|_| {
            Box::pin(async {
                Ok(integration::Authorization::automatic(
                    "https://auth.invalid".into(),
                    "Sign in".into(),
                    Box::pin(std::future::pending()),
                    None,
                    Some(0),
                ))
            })
        }),
        refresh: None,
        label: None,
    };
    fixture.registrations.push(
        fixture
            .registry
            .transform(move |draft| draft.oauth(implementation.clone()))
            .unwrap(),
    );
    let mut harness = Harness::new(fixture.environment(true)).await;
    let command: v5::ProviderAuthBeginResult = harness
        .ask(NAMES[2], global(), auth_begin(&fixture, "command"))
        .await;
    assert_eq!(command.data.r#type, 2);
    assert!(command.data.url.is_none());
    let status: v5::ProviderAuthStatusResult = harness
        .ask(
            NAMES[3],
            global(),
            auth_status(&fixture, &command.data.attempt_id),
        )
        .await;
    assert_eq!(status.data.status, 1);
    assert!(status.data.message.is_none());
    harness
        .refuse(
            NAMES[4],
            global(),
            v5::ProviderAuthCompleteRequest {
                payload: v5::ProviderAuthCompleteRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: command.data.attempt_id.clone(),
                    code: text("finish"),
                },
            },
            1,
        )
        .await;
    let _: v5::ProviderAuthCancelResult = harness
        .ask(
            NAMES[5],
            global(),
            v5::ProviderAuthCancelRequest {
                payload: v5::ProviderAuthCancelRequestPayload {
                    target: target(&fixture.root),
                    integration_id: text(&fixture.integration),
                    attempt_id: command.data.attempt_id,
                },
            },
        )
        .await;
    let expired: v5::ProviderAuthBeginResult = harness
        .ask(NAMES[2], global(), auth_begin(&fixture, "expired"))
        .await;
    harness
        .refuse(
            NAMES[3],
            global(),
            auth_status(&fixture, &expired.data.attempt_id),
            1,
        )
        .await;
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn uncertain_auth_begin_keeps_its_reservation_without_replaying_provider_work() {
    let mut fixture = Fixture::new().await;
    let calls = fixture.calls.clone();
    let implementation = integration::OAuthImplementation {
        integration: fixture.integration.as_str().into(),
        method: ycoding_core::ycoding_schema::integration::OAuthMethod {
            id: ycoding_core::ycoding_schema::integration::MethodId::new("unknown").unwrap(),
            label: "Unknown".into(),
            prompts: None,
            remote: Some(true),
        },
        authorize: Arc::new(move |_| {
            calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async { Err(ycoding_core::resources::credential::Error::UnknownOutcome) })
        }),
        refresh: None,
        label: None,
    };
    fixture.registrations.push(
        fixture
            .registry
            .transform(move |draft| draft.oauth(implementation.clone()))
            .unwrap(),
    );
    let mut harness = Harness::new(fixture.environment(true)).await;
    for _ in 0..32 {
        harness
            .refuse(NAMES[2], global(), auth_begin(&fixture, "unknown"), 11)
            .await;
    }
    assert_eq!(fixture.calls.load(Ordering::Acquire), 32);
    harness
        .refuse(NAMES[2], global(), auth_begin(&fixture, "unknown"), 1)
        .await;
    assert_eq!(fixture.calls.load(Ordering::Acquire), 32);
    harness.close().await;
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn status_separates_pending_attention_and_failed_roots() {
    let fixture = Fixture::new().await;
    let mut harness = Harness::new(fixture.environment(true)).await;
    activate(&fixture.child).await;
    let child = session::Id::new(fixture.child.as_str()).unwrap();
    let permissions = world()
        .core
        .locations
        .session(&child)
        .unwrap()
        .1
        .permissions
        .clone();
    let id =
        ycoding_core::ycoding_schema::permission::Id::new(format!("per_{}", fixture.root)).unwrap();
    let admission = permissions
        .ask(
            ycoding_core::ycoding_schema::permission::Request {
                id: id.clone(),
                session_id: child.clone(),
                action: "shell".into(),
                resources: vec!["safe".into()],
                save: None,
                metadata: None,
                source: None,
            },
            None,
        )
        .unwrap();
    assert!(admission.wait.is_some());
    let btw = format!("{}_pending", fixture.root);
    let _: v5::SessionSideChatCreateResult = harness
        .ask(
            NAMES[11],
            session_scope(&fixture.other),
            v5::SessionSideChatCreateRequest {
                payload: v5::SessionSideChatCreateRequestPayload { id: text(&btw) },
            },
        )
        .await;
    let failed = format!("{}_failed", fixture.root);
    create(&failed, &fixture.project, &fixture.directory, None, "build").await;
    world().core.sessions.publish(tables::NewEvent { id: format!("evt_failure_{failed}").into(), aggregate_id: failed.as_str().into(), created: remote_derived_support::now(), type_: "session.execution.failed.1".into(), data: parse_json(&format!(r#"{{"sessionID":"{failed}","error":{{"type":"unknown","message":"Synthetic failure"}}}}"#)).unwrap() }).await.unwrap();
    let status: v5::SessionStatusResult = harness
        .ask(NAMES[8], machine(), v5::SessionStatusRequest {})
        .await;
    assert!(
        status
            .running
            .items
            .iter()
            .any(|id| units(id) == fixture.root)
    );
    assert!(
        status
            .attention
            .items
            .iter()
            .any(|id| units(id) == fixture.root)
    );
    assert!(status.attention.items.iter().any(|id| units(id) == failed));
    assert!(
        status
            .outstanding
            .as_ref()
            .unwrap()
            .items
            .iter()
            .any(|id| units(id) == fixture.other)
    );
    assert!(
        status
            .failed
            .as_ref()
            .unwrap()
            .items
            .iter()
            .any(|id| units(id) == failed)
    );
    assert!(
        !status
            .failed
            .as_ref()
            .unwrap()
            .items
            .iter()
            .any(|id| units(id) == fixture.root)
    );
    permissions.cancel(&id);
    stop(&fixture.child).await;
    harness.close().await;
    fixture.close().await;
}
