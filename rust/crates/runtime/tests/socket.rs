mod support;

use prost::{Message, Name};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use support::*;
use tokio::sync::{Notify, oneshot};
use ycoding_protocol::{CONTRACT_DIGEST, OPERATIONS, connection::Outcome, limits, v5};
use ycoding_runtime::{Dispatcher, Failure, LocalAuth, standard};

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn health_result() -> v5::HealthGetResult {
    v5::HealthGetResult {
        data: v5::ServiceHealth {
            healthy: true,
            version: text("v"),
            pid: 1,
            source_epoch: text("e"),
        },
    }
}

fn counting() -> (Dispatcher, Arc<AtomicUsize>) {
    let mut dispatcher = bare_dispatcher();
    let count = Arc::new(AtomicUsize::new(0));
    let counter = count.clone();
    dispatcher
        .handle("health.get", move |_, _: v5::HealthGetRequest| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(health_result())
            }
        })
        .unwrap();
    (dispatcher, count)
}

fn digest() -> Vec<u8> {
    (0..CONTRACT_DIGEST.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&CONTRACT_DIGEST[index..index + 2], 16).unwrap())
        .collect()
}

fn frame(epoch: Option<&str>, body: v5::frame::Body) -> Vec<u8> {
    v5::Frame {
        revision: 5,
        connection_epoch: epoch.map(Into::into),
        ledger: None,
        delivery_ordinal: None,
        tiny_consumed_through: None,
        body: Some(body),
    }
    .encode_to_vec()
}

fn hello(revision: u32, digest: Vec<u8>, role: v5::PeerRole) -> v5::frame::Body {
    v5::frame::Body::Hello(v5::Hello {
        revision,
        contract_digest: digest,
        role: role as i32,
        receive_windows: v5::ReceiveWindows {
            normal_bytes: 1 << 20,
            event_bytes: 1 << 20,
            bulk_bytes: 1 << 19,
        },
    })
}

fn get_request(session: &str) -> Vec<u8> {
    v5::SessionGetRequest {
        params: v5::SessionGetRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

fn declared(descriptor: &v5::OperationDescriptor, payload: &v5::TypedPayload) -> bool {
    descriptor.error_types.contains(&payload.type_name)
}

async fn global_form_publication(cancel: bool) {
    use support::wire::{ask, form_scope, location_scope, query, refuse};
    use ycoding_core::event_feed::{Payload, Scope};
    use ycoding_core::ycoding_schema::{DomainDecode, form, parse_json};

    bounded(async {
        let directory = if cancel { "/project/global-cancel" } else { "/project/global-reply" };
        let foreign = if cancel { "/project/global-cancel-other" } else { "/project/global-reply-other" };
        let id = if cancel { "frm_global_cancel_socket" } else { "frm_global_reply_socket" };
        insert_project(&format!("prj_{id}_own"), directory).await;
        insert_project(&format!("prj_{id}_other"), foreign).await;
        let core = &world().core;
        let own = core.locations.location(&directory.into(), None).unwrap();
        let other = core.locations.location(&foreign.into(), None).unwrap();
        let global = core.events.subscribe(Scope::Global, None, || {}).unwrap();
        let session = core.events.subscribe(Scope::Session(ycoding_core::ycoding_schema::session::Id::new("ses_global_form_observer_socket").unwrap()), None, || {}).unwrap();
        let input = form::Info::decode(&parse_json(&format!(r#"{{"id":"{id}","sessionID":"global","title":"MCP input","fields":[{{"key":"name","type":"string","required":true}}]}}"#)).unwrap()).unwrap();
        let wait = own.forms.ask(input.clone()).unwrap();
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let listed: v5::FormRequestListResult = ask(&mut client, "form.request.list", location_scope(directory), v5::FormRequestListRequest { query: query(directory, None) }).await;
        assert_eq!(listed.data.items.len(), 1);
        assert_eq!(units(&listed.data.items[0].id), id);
        assert_eq!(units(&listed.data.items[0].session_id), "global");
        let hidden: v5::FormRequestListResult = ask(&mut client, "form.request.list", location_scope(foreign), v5::FormRequestListRequest { query: query(foreign, None) }).await;
        assert!(hidden.data.items.is_empty());
        assert_eq!(other.forms.get(&input.id), Err(ycoding_core::tools::policy::forms::Error::NotFound));
        assert_eq!(other.forms.cancel(&input.id), Err(ycoding_core::tools::policy::forms::Error::NotFound));
        assert_eq!(other.forms.reply(&input.id, form::Answer::decode(&parse_json(r#"{"name":"Ava"}"#).unwrap()).unwrap()), Err(ycoding_core::tools::policy::forms::Error::NotFound));
        let _: v5::InvalidRequestError = refuse(&mut client, "session.form.list", form_scope("global"), v5::SessionFormListRequest { params: v5::SessionFormListRequestParams { session_id: text("global") } }).await;
        let settlement = if cancel {
            own.forms.cancel(&input.id)
        } else {
            own.forms.reply(&input.id, form::Answer::decode(&parse_json(r#"{"name":"Ava"}"#).unwrap()).unwrap())
        };
        settlement.expect("global Form settlement must publish without a real Session");
        let settled = wait.await.unwrap();
        assert_eq!(own.forms.state(&input.id).unwrap(), settled);
        assert!(own.forms.list(None).is_empty());
        let drained: v5::FormRequestListResult = ask(&mut client, "form.request.list", location_scope(directory), v5::FormRequestListRequest { query: query(directory, None) }).await;
        assert!(drained.data.items.is_empty());
        let expected = if cancel { "form.cancelled" } else { "form.replied" };
        let events = std::iter::from_fn(|| global.next().unwrap()).filter_map(|item| {
            let Payload::Ephemeral(event) = &item.payload else { return None; };
            if !["form.created", expected].contains(&event.data.name()) { return None; }
            let path = Default::default();
            let encoded = ycoding_core::ycoding_schema::DomainEncode::encode(&event.data);
            let data = ycoding_core::ycoding_schema::ObjectDecoder::new(&encoded, &path).unwrap();
            let form_id = if event.data.name() == "form.created" { data.field::<form::Info>("form").unwrap().id } else { data.field::<form::Id>("id").unwrap() };
            (form_id == input.id).then(|| event.clone())
        }).collect::<Vec<_>>();
        assert_eq!(events.iter().map(|event| event.data.name()).collect::<Vec<_>>(), ["form.created", expected]);
        assert!(events.iter().all(|event| event.session.is_none()));
        assert!(session.next().unwrap().is_none());
        server.shutdown().await.unwrap();
    }).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_form_reply_is_location_listed_and_published_without_a_session() {
    global_form_publication(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_form_cancel_is_location_listed_and_published_without_a_session() {
    global_form_publication(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_form_settlement_events_accept_the_global_owner_sentinel() {
    use ycoding_core::event_feed::{Payload, Scope};
    use ycoding_core::tools::policy::Event;
    use ycoding_core::ycoding_schema::{parse_json, session};

    let core = &world().core;
    let id = session::Id::new("ses_form_event_owner_socket").unwrap();
    let subscriber = core
        .events
        .subscribe(Scope::Session(id.clone()), None, || {})
        .unwrap();
    for kind in ["form.replied", "form.cancelled", "session.status"] {
        (core.publisher)(Event {
            type_: kind,
            data: parse_json(
                r#"{"sessionID":"ses_form_event_owner_socket","id":"frm_owner","answer":{},"status":{"type":"busy"}}"#,
            )
            .unwrap(),
        })
        .unwrap();
        let item = subscriber.next().unwrap().unwrap();
        let Payload::Ephemeral(event) = &item.payload else {
            panic!("expected ephemeral publication");
        };
        assert_eq!(event.session.as_ref(), Some(&id));
        assert_eq!(event.data.name(), kind);
    }
    assert!(
        (core.publisher)(Event {
            type_: "session.status",
            data: parse_json(r#"{"sessionID":"global"}"#).unwrap(),
        })
        .is_err()
    );
    assert!(subscriber.next().unwrap().is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authenticated_connection_serves_typed_bootstrap_operations() {
    bounded(async {
        let server = start(
            services(LocalAuth::with_password("secret"), false),
            standard().unwrap(),
        )
        .await;
        let mut client = Client::open(server.address(), &[("Authorization", basic("secret"))])
            .await
            .unwrap();
        let health: v5::HealthGetResult = success(
            client
                .call(
                    "health.get",
                    machine(),
                    v5::HealthGetRequest {}.encode_to_vec(),
                )
                .await,
        );
        assert!(
            health.data.healthy,
            "the typed health answer is the literal true; readiness is a separate state"
        );
        assert_eq!(units(&health.data.version), "9.9.9-test");
        assert_eq!(units(&health.data.source_epoch), "source-epoch-test");
        assert_eq!(health.data.pid, std::process::id() as u64);
        let urls: v5::ServerGetResult = success(
            client
                .call(
                    "server.get",
                    machine(),
                    v5::ServerGetRequest {}.encode_to_vec(),
                )
                .await,
        );
        assert_eq!(
            urls.urls.items.iter().map(units).collect::<Vec<_>>(),
            vec![format!("http://{}", server.address())]
        );
        server.shutdown().await.unwrap();

        let ready = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(ready.address(), &[]).await.unwrap();
        let health: v5::HealthGetResult = success(
            client
                .call(
                    "health.get",
                    machine(),
                    v5::HealthGetRequest {}.encode_to_vec(),
                )
                .await,
        );
        assert!(health.data.healthy);
        ready.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_and_origin_failures_never_upgrade() {
    bounded(async {
        let server = start(
            services(LocalAuth::with_password("secret"), false),
            standard().unwrap(),
        )
        .await;
        let address = server.address();
        assert_eq!(Socket::connect(address, &[]).await.err(), Some(401));
        assert_eq!(
            Socket::connect(address, &[("Authorization", basic("wrong"))])
                .await
                .err(),
            Some(401)
        );
        assert_eq!(
            Socket::connect(
                address,
                &[("Authorization", basic_for("someone", "secret"))]
            )
            .await
            .err(),
            Some(401)
        );
        assert_eq!(
            Socket::connect(address, &[("Authorization", "Bearer secret".into())])
                .await
                .err(),
            Some(401)
        );
        for origin in [
            "https://evil.example",
            "http://localhost.evil.example",
            "http://127.0.0.1",
        ] {
            assert_eq!(
                Socket::connect(
                    address,
                    &[
                        ("Authorization", basic("secret")),
                        ("Origin", origin.into())
                    ]
                )
                .await
                .err(),
                Some(403),
                "{origin}"
            );
        }
        for origin in [
            "http://localhost:5173".to_string(),
            "http://127.0.0.1:3000".to_string(),
            format!("http://{address}"),
        ] {
            assert!(
                Socket::connect(
                    address,
                    &[
                        ("Authorization", basic("secret")),
                        ("Origin", origin.clone())
                    ]
                )
                .await
                .is_ok(),
                "{origin}"
            );
        }
        assert!(
            Socket::connect(address, &[("Authorization", basic("secret"))])
                .await
                .is_ok()
        );
        server.shutdown().await.unwrap();

        let mut configured = services(LocalAuth::disabled(), false);
        configured.cors = vec!["https://app.example".into()];
        let server = start(configured, standard().unwrap()).await;
        assert!(
            Socket::connect(
                server.address(),
                &[("Origin", "https://app.example".into())]
            )
            .await
            .is_ok()
        );
        assert_eq!(
            Socket::connect(
                server.address(),
                &[("Origin", "https://other.example".into())]
            )
            .await
            .err(),
            Some(403)
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn handshake_mismatches_close_before_ready_without_dispatch() {
    bounded(async {
        let (dispatcher, count) = counting();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut wrong_digest = digest();
        wrong_digest[0] ^= 0xff;
        let cases = [
            (
                "revision",
                frame(None, hello(4, digest(), v5::PeerRole::LocalClient)),
            ),
            (
                "digest",
                frame(None, hello(5, wrong_digest, v5::PeerRole::LocalClient)),
            ),
            (
                "role",
                frame(None, hello(5, digest(), v5::PeerRole::RemoteClient)),
            ),
            (
                "fabricated epoch",
                frame(
                    Some("forged"),
                    hello(5, digest(), v5::PeerRole::LocalClient),
                ),
            ),
            ("old text", b"{\"hello\":true}".to_vec()),
        ];
        for (name, bytes) in cases {
            let mut socket = Socket::connect(server.address(), &[]).await.unwrap();
            if name == "old text" {
                socket.send_text(std::str::from_utf8(&bytes).unwrap()).await;
            } else {
                socket.send_binary(&bytes).await;
            }
            let (code, reason) = socket
                .expect_end()
                .await
                .unwrap_or_else(|| panic!("{name}: no close frame"));
            assert_eq!(code, 1008, "{name}");
            assert!(
                reason.is_ascii() && !reason.is_empty() && reason.len() <= 96,
                "{name}: {reason}"
            );
        }
        let mut valid = Socket::connect(server.address(), &[]).await.unwrap();
        valid
            .send_binary(&frame(None, hello(5, digest(), v5::PeerRole::LocalClient)))
            .await;
        let Received::Binary(ready) = valid.receive().await else {
            panic!("expected Ready");
        };
        let ready = v5::Frame::decode(ready.as_slice()).unwrap();
        let Some(v5::frame::Body::Ready(body)) = ready.body else {
            panic!("expected Ready body");
        };
        assert_eq!(body.source_epoch, "source-epoch-test");
        assert_eq!(
            ready.connection_epoch.as_deref(),
            Some(body.connection_epoch.as_str())
        );
        valid
            .send_binary(&frame(None, hello(5, digest(), v5::PeerRole::LocalClient)))
            .await;
        let (code, _) = valid.expect_end().await.unwrap();
        assert_eq!(
            code, 1008,
            "repeated Hello before Ready receipt confirmation"
        );
        assert_eq!(count.load(Ordering::SeqCst), 0);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_established_frames_close_without_dispatch() {
    bounded(async {
        let (dispatcher, count) = counting();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;

        let mut early = Socket::connect(server.address(), &[]).await.unwrap();
        early
            .send_binary(&frame(
                None,
                v5::frame::Body::Request(v5::Request {
                    request_id: "1".into(),
                    operation_id: operation("health.get").operation_id,
                    scope: machine(),
                    payload: Vec::new(),
                }),
            ))
            .await;
        assert_eq!(
            early.expect_end().await.unwrap().0,
            1008,
            "Request before Hello"
        );

        let mut oversized_handshake = Socket::connect(server.address(), &[]).await.unwrap();
        oversized_handshake
            .send_binary(&vec![0u8; limits::HANDSHAKE_BYTES as usize + 1])
            .await;
        assert!(
            oversized_handshake
                .expect_end()
                .await
                .is_none_or(|(code, _)| code != 1000)
        );

        let mut client = Client::open(server.address(), &[]).await.unwrap();
        client
            .socket
            .send_binary(&vec![0u8; limits::CLIENT_FRAME_BYTES as usize + 1])
            .await;
        assert!(client.closed().await.0 != 1000);

        let mut client = Client::open(server.address(), &[]).await.unwrap();
        client.socket.send_text("not binary").await;
        assert_eq!(client.closed().await.0, 1002, "text after Ready");

        let mut client = Client::open(server.address(), &[]).await.unwrap();
        client.socket.send_binary(&[0xff, 0xff, 0xff]).await;
        assert_eq!(client.closed().await.0, 1002, "malformed Protobuf");

        let mut client = Client::open(server.address(), &[]).await.unwrap();
        client
            .socket
            .send_binary(&frame(
                Some("stale-epoch"),
                v5::frame::Body::Request(v5::Request {
                    request_id: "1".into(),
                    operation_id: operation("health.get").operation_id,
                    scope: machine(),
                    payload: Vec::new(),
                }),
            ))
            .await;
        assert_eq!(client.closed().await.0, 1002, "wrong established epoch");

        assert_eq!(count.load(Ordering::SeqCst), 0);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_and_non_local_operations_close_without_dispatch() {
    bounded(async {
        let (dispatcher, count) = counting();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let non_local = OPERATIONS
            .iter()
            .find(|descriptor| {
                !descriptor
                    .roles
                    .contains(&(v5::PeerRole::LocalClient as i32))
            })
            .unwrap()
            .operation_id;
        for operation_id in [4_999_999, non_local] {
            let mut client = Client::open(server.address(), &[]).await.unwrap();
            let epoch = client.epoch.clone();
            client
                .socket
                .send_binary(
                    &v5::Frame {
                        revision: 5,
                        connection_epoch: Some(epoch),
                        ledger: Some(v5::LedgerClass::Normal as i32),
                        delivery_ordinal: Some(1),
                        tiny_consumed_through: None,
                        body: Some(v5::frame::Body::Request(v5::Request {
                            request_id: "1".into(),
                            operation_id,
                            scope: machine(),
                            payload: Vec::new(),
                        })),
                    }
                    .encode_to_vec(),
                )
                .await;
            assert_eq!(client.closed().await.0, 1002, "operation {operation_id}");
        }
        assert_eq!(count.load(Ordering::SeqCst), 0);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unwired_operations_return_typed_unavailable_errors() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), bare_dispatcher()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let descriptor = operation("remote.get");
        let payload = rejected(client.call("remote.get", machine(), Vec::new()).await);
        assert!(declared(&descriptor, &payload), "{}", payload.type_name);
        let error = v5::InvalidRequestError::decode(payload.payload.as_slice()).unwrap();
        assert_eq!(units(&error.kind.unwrap()), "unavailable");
        assert!(units(&error.message).contains("remote.get has no Core service wired"));
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn credential_mutations_use_the_global_store_without_disclosing_secrets() {
    bounded(async {
        use ycoding_core::ycoding_schema::{DomainEncode, credential};
        use ycoding_core::ycoding_store::resources::Secret;

        let id = format!("credential-wire-{}", std::process::id());
        let core = &world().core;
        core.credentials
            .create(
                id.clone().into(),
                "wire-test".into(),
                Some("Work".into()),
                Secret::new(
                    credential::Value::Key(credential::Key {
                        key: "fixture-secret".into(),
                        metadata: None,
                    })
                    .encode(),
                )
                .unwrap(),
                1,
            )
            .await
            .unwrap();

        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let scope = wire::location_scope("/project");
        let query = v5::LocationQuery { location: None };
        let updated: v5::CredentialUpdateResult = wire::ask(
            &mut client,
            "credential.update",
            scope.clone(),
            v5::CredentialUpdateRequest {
                params: v5::CredentialUpdateRequestParams {
                    credential_id: text(&id),
                },
                query: query.clone(),
                payload: v5::CredentialUpdateRequestPayload {
                    label: text("Personal"),
                },
            },
        )
        .await;
        assert_eq!(updated.data, v5::Empty {});
        assert_eq!(
            core.credentials
                .get(&id.clone().into())
                .unwrap()
                .unwrap()
                .label()
                .as_str(),
            Some("Personal")
        );

        let activated: v5::CredentialActivateResult = wire::ask(
            &mut client,
            "credential.activate",
            scope.clone(),
            v5::CredentialActivateRequest {
                params: v5::CredentialActivateRequestParams {
                    credential_id: text(&id),
                },
                query: query.clone(),
            },
        )
        .await;
        assert_eq!(activated.data, v5::Empty {});

        let removed: v5::CredentialRemoveResult = wire::ask(
            &mut client,
            "credential.remove",
            scope,
            v5::CredentialRemoveRequest {
                params: v5::CredentialRemoveRequestParams {
                    credential_id: text(&id),
                },
                query,
            },
        )
        .await;
        assert_eq!(removed.data, v5::Empty {});
        assert!(core.credentials.get(&id.into()).unwrap().is_none());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_local_operation_answers_with_a_declared_typed_outcome() {
    bounded(async {
        let dispatcher = standard().unwrap();
        let mut wired = dispatcher
            .wired()
            .into_iter()
            .map(String::from)
            .collect::<Vec<_>>();
        wired.sort();
        assert_eq!(
            wired,
            [
                "agent.list",
                "artifact.confirmGlobal",
                "artifact.create",
                "artifact.disable",
                "artifact.enable",
                "artifact.fork.confirm",
                "artifact.fork.preview",
                "artifact.get",
                "artifact.list",
                "artifact.metrics",
                "artifact.promotion.confirm",
                "artifact.promotion.preview",
                "artifact.purge",
                "artifact.remove",
                "artifact.restore",
                "artifact.revert",
                "artifact.shadow.confirm",
                "artifact.shadow.preview",
                "artifact.update",
                "browser.action",
                "browser.close",
                "browser.control",
                "browser.forget",
                "browser.observe",
                "browser.open",
                "browser.release",
                "browser.start",
                "browser.status",
                "browser.stop",
                "browser.tabs",
                "catalog.get",
                "command.list",
                "config.diagnostics",
                "credential.activate",
                "credential.remove",
                "credential.update",
                "event.subscribe",
                "event.unsubscribe",
                "form.request.list",
                "fs.find",
                "fs.list",
                "generate.text",
                "health.get",
                "health.stop",
                "integration.command.cancel",
                "integration.command.connect",
                "integration.command.status",
                "integration.connect.key",
                "integration.get",
                "integration.list",
                "integration.oauth.cancel",
                "integration.oauth.complete",
                "integration.oauth.connect",
                "integration.oauth.status",
                "integration.wellknown.add",
                "isolatedBrowser.action",
                "isolatedBrowser.control",
                "isolatedBrowser.observe",
                "isolatedBrowser.start",
                "isolatedBrowser.status",
                "isolatedBrowser.stop",
                "isolatedBrowser.tabs",
                "keepAwake.get",
                "keepAwake.set",
                "mcp.add",
                "mcp.connect",
                "mcp.disconnect",
                "mcp.list",
                "mcp.remove",
                "mcp.resource.catalog",
                "model.default",
                "model.list",
                "permission.request.list",
                "permission.saved.list",
                "permission.saved.remove",
                "plugin.list",
                "project.current",
                "project.directories",
                "project.forget",
                "project.inventory",
                "project.list",
                "projectCopy.create",
                "projectCopy.refresh",
                "projectCopy.remove",
                "provider.auth.begin",
                "provider.auth.cancel",
                "provider.auth.complete",
                "provider.auth.key",
                "provider.auth.list",
                "provider.auth.status",
                "provider.get",
                "provider.integrations",
                "provider.list",
                "provider.refresh",
                "providerUsage.get",
                "providerUsage.list",
                "pty.connectToken",
                "pty.control",
                "pty.create",
                "pty.get",
                "pty.list",
                "pty.remove",
                "pty.update",
                "question.request.list",
                "reference.list",
                "remote.get",
                "remote.set",
                "server.get",
                "session.active",
                "session.archive",
                "session.autonomy.get",
                "session.autonomy.set",
                "session.background",
                "session.capturedChanges.list",
                "session.capturedInputs",
                "session.compaction.list",
                "session.completions",
                "session.context",
                "session.create",
                "session.daybreak.set",
                "session.diagnostics",
                "session.family.activity",
                "session.fileChange.list",
                "session.fork",
                "session.form.cancel",
                "session.form.create",
                "session.form.get",
                "session.form.list",
                "session.form.reply",
                "session.form.state",
                "session.get",
                "session.guardrail.request.list",
                "session.guardrail.request.reply",
                "session.guardrail.status",
                "session.instructions.entry.list",
                "session.instructions.entry.put",
                "session.instructions.entry.remove",
                "session.interrupt",
                "session.list",
                "session.log",
                "session.message",
                "session.messages",
                "session.outstanding",
                "session.pending.list",
                "session.permission.create",
                "session.permission.get",
                "session.permission.list",
                "session.permission.reply",
                "session.pin",
                "session.prediction",
                "session.prompt",
                "session.promptGenerate",
                "session.question.list",
                "session.question.reject",
                "session.question.reply",
                "session.remove",
                "session.rename",
                "session.revert.clear",
                "session.revert.commit",
                "session.revert.stage",
                "session.side-chat.create",
                "session.side-chat.list",
                "session.snapshot",
                "session.status",
                "session.subagent.answer",
                "session.subagent.cancel",
                "session.subagent.list",
                "session.subagent.message",
                "session.subagent.resume",
                "session.synthetic",
                "session.team.economics",
                "session.team.shell.kill",
                "session.team.shell.list",
                "session.todo.list",
                "session.todo.update",
                "session.unarchive",
                "session.unpin",
                "session.usage",
                "session.usageReport",
                "session.wait",
                "shell.create",
                "shell.get",
                "shell.list",
                "shell.output",
                "shell.remove",
                "shell.timeout",
                "skill.list",
                "telemetry.append",
                "telemetry.consent.get",
                "telemetry.consent.set",
                "telemetry.list",
                "usage.get",
                "usage.report",
                "vcs.branch",
                "vcs.diff",
                "vcs.status",
                "workspace.list"
            ]
        );
        let environment = Arc::new(ycoding_runtime::Environment {
            services: services(LocalAuth::disabled(), false),
            urls: Vec::new(),
            subscriptions: ycoding_runtime::Subscriptions::default(),
        });
        let mut local = 0;
        for descriptor in OPERATIONS.iter() {
            let local_operation = descriptor
                .roles
                .contains(&(v5::PeerRole::LocalClient as i32));
            let result = dispatcher
                .invoke(
                    environment.clone(),
                    "test-connection".into(),
                    v5::Request {
                        request_id: "1".into(),
                        operation_id: descriptor.operation_id,
                        scope: machine(),
                        payload: Vec::new(),
                    },
                )
                .await;
            if !local_operation {
                assert!(
                    result.is_none(),
                    "{} is not a local operation and must not be answered",
                    descriptor.diagnostic_name
                );
                continue;
            }
            let Some(ycoding_runtime::Settled::Result(result)) = result else {
                panic!("{} must settle inline", descriptor.diagnostic_name);
            };
            assert_eq!(result.operation_id, descriptor.operation_id);
            assert_eq!(result.settlement, descriptor.settlement);
            match result.outcome.unwrap() {
                v5::result::Outcome::Error(payload) => {
                    assert!(
                        declared(descriptor, &payload),
                        "{}: {}",
                        descriptor.diagnostic_name,
                        payload.type_name
                    );
                }
                v5::result::Outcome::Success(payload) => {
                    assert!(wired.contains(&descriptor.diagnostic_name));
                    assert_eq!(payload.type_name, descriptor.result_type);
                }
                v5::result::Outcome::AssetMetadata(_) => {
                    panic!("{} must settle inline", descriptor.diagnostic_name);
                }
            }
            local += usize::from(local_operation);
        }
        println!(
            "local operations: {local}; wired: {}; typed-unavailable: {}",
            wired.len(),
            local - wired.len()
        );
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authorization_hook_runs_before_the_handler() {
    bounded(async {
        let (mut dispatcher, count) = counting();
        dispatcher
            .authorize("health.get", |_, _| {
                Err(Failure::Unauthorized("denied by hook".into()))
            })
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let payload = rejected(
            client
                .call(
                    "health.get",
                    machine(),
                    v5::HealthGetRequest {}.encode_to_vec(),
                )
                .await,
        );
        assert_eq!(payload.type_name, v5::UnauthorizedError::full_name());
        let error = v5::UnauthorizedError::decode(payload.payload.as_slice()).unwrap();
        assert_eq!(units(&error.message), "denied by hook");
        assert_eq!(count.load(Ordering::SeqCst), 0);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_get_reads_the_stored_session_and_rejects_unknown_or_mismatched_scope() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let info: v5::SessionGetResult = success(
            client
                .call(
                    "session.get",
                    session_scope("ses_get"),
                    get_request("ses_get"),
                )
                .await,
        );
        assert_eq!(units(&info.data.id), "ses_get");
        assert_eq!(units(&info.data.project_id), "prj_one");
        assert_eq!(units(&info.data.title), "Title of ses_get");
        assert_eq!(units(&info.data.location.directory), "/project");
        assert_eq!(info.data.time.created, 1.0);
        assert_eq!(info.data.cost, 0.0);
        assert!(
            info.data.parent_id.is_none()
                && info.data.model.is_none()
                && info.data.revert.is_none()
        );

        let descriptor = operation("session.get");
        let missing = rejected(
            client
                .call(
                    "session.get",
                    session_scope("ses_missing"),
                    get_request("ses_missing"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        assert!(declared(&descriptor, &missing));
        assert_eq!(
            units(
                &v5::SessionNotFoundError::decode(missing.payload.as_slice())
                    .unwrap()
                    .session_id
            ),
            "ses_missing"
        );

        let mismatched = rejected(
            client
                .call(
                    "session.get",
                    session_scope("ses_get"),
                    get_request("ses_other"),
                )
                .await,
        );
        assert_eq!(mismatched.type_name, v5::InvalidRequestError::full_name());
        server.shutdown().await.unwrap();

        let not_ready = start(services(LocalAuth::disabled(), false), standard().unwrap()).await;
        let mut client = Client::open(not_ready.address(), &[]).await.unwrap();
        let unavailable = rejected(
            client
                .call(
                    "session.get",
                    session_scope("ses_get"),
                    get_request("ses_get"),
                )
                .await,
        );
        assert_eq!(unavailable.type_name, v5::InvalidRequestError::full_name());
        let error = v5::InvalidRequestError::decode(unavailable.payload.as_slice()).unwrap();
        assert_eq!(units(&error.message), "Core is not ready");
        not_ready.shutdown().await.unwrap();
    })
    .await;
}

fn prompt_request(session: &str, id: Option<&str>, body: &str, files: bool) -> Vec<u8> {
    v5::SessionPromptRequest {
        params: v5::SessionPromptRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPromptRequestPayload {
            id: id.map(text),
            text: text(body),
            files: files.then(|| v5::SessionPromptRequestPayloadFiles {
                items: vec![v5::PromptInputFileAttachment {
                    uri: text("file:///project/a.txt"),
                    name: None,
                    description: None,
                    mention: None,
                }],
            }),
            agents: Some(v5::SessionPromptRequestPayloadAgents {
                items: vec![v5::PromptAgentAttachment {
                    name: text("reviewer"),
                    mention: None,
                }],
            }),
            metadata: Some(v5::SessionPromptRequestPayloadMetadata {
                entries: vec![v5::SessionPromptRequestPayloadMetadataEntry {
                    key: text("origin"),
                    value: v5::Value {
                        kind: Some(v5::value::Kind::String(text("socket-test"))),
                    },
                }],
            }),
            delivery: Some(v5::SessionPromptRequestPayloadDelivery::Queue as i32),
            resume: Some(false),
        },
    }
    .encode_to_vec()
}

async fn wait_for_admission(id: &str) {
    let id = ycoding_core::ycoding_schema::session_message::Id::new(id).unwrap();
    for _ in 0..500 {
        if world().core.sessions.pending(&id).unwrap().is_some() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the prompt was never durably admitted");
}

fn pending_count(session: &str) -> i64 {
    ycoding_core::ycoding_store::session::latest_sequence(
        &world().store.snapshot().unwrap(),
        &session.into(),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_prompt_admits_durably_and_a_same_id_retry_reconciles_after_a_lost_response() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        assert_eq!(pending_count("ses_retry"), -1);

        let mut lost = Client::open(server.address(), &[]).await.unwrap();
        lost.send(
            "session.prompt",
            session_scope("ses_retry"),
            prompt_request("ses_retry", Some("msg_retry_one"), "first text", false),
        )
        .await;
        wait_for_admission("msg_retry_one").await;
        drop(lost);

        let mut retry = Client::open(server.address(), &[]).await.unwrap();
        let admitted: v5::SessionPromptResult = success(
            retry
                .call(
                    "session.prompt",
                    session_scope("ses_retry"),
                    prompt_request("ses_retry", Some("msg_retry_one"), "second text", false),
                )
                .await,
        );
        assert_eq!(units(&admitted.data.id), "msg_retry_one");
        assert_eq!(units(&admitted.data.session_id), "ses_retry");
        assert_eq!(
            admitted.data.delivery,
            v5::SessionPendingUserDelivery::SessionpendingUserDeliveryQueue as i32
        );
        assert_eq!(units(&admitted.data.data.text), "first text");
        assert_eq!(admitted.data.data.agents.unwrap().items.len(), 1);
        assert_eq!(admitted.data.data.metadata.unwrap().entries.len(), 1);
        assert_eq!(
            pending_count("ses_retry"),
            0,
            "exactly one durable admission"
        );

        let descriptor = operation("session.prompt");
        let result = {
            let id = retry
                .send(
                    "session.prompt",
                    session_scope("ses_prompt"),
                    prompt_request("ses_prompt", None, "generated id", false),
                )
                .await;
            retry.settle(&id).await
        };
        let Outcome::Success {
            settlement,
            payload,
        } = result
        else {
            panic!("expected admission");
        };
        assert_eq!(settlement, v5::Settlement::DurablyAdmitted);
        assert_eq!(settlement as i32, descriptor.settlement);
        let generated = v5::SessionPromptResult::decode(payload.payload.as_slice()).unwrap();
        assert!(units(&generated.data.id).starts_with("msg_"));
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_prompt_refuses_unresolved_files_and_cross_session_reuse_without_admission() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let before = pending_count("ses_files");
        let files = rejected(
            client
                .call(
                    "session.prompt",
                    session_scope("ses_files"),
                    prompt_request("ses_files", Some("msg_files"), "with file", true),
                )
                .await,
        );
        assert_eq!(files.type_name, v5::InvalidRequestError::full_name());
        assert_eq!(pending_count("ses_files"), before);

        let _: v5::SessionPromptResult = success(
            client
                .call(
                    "session.prompt",
                    session_scope("ses_conflict_a"),
                    prompt_request("ses_conflict_a", Some("msg_shared"), "one", false),
                )
                .await,
        );
        let conflict = rejected(
            client
                .call(
                    "session.prompt",
                    session_scope("ses_conflict_b"),
                    prompt_request("ses_conflict_b", Some("msg_shared"), "two", false),
                )
                .await,
        );
        assert_eq!(conflict.type_name, v5::ConflictError::full_name());
        assert_eq!(pending_count("ses_conflict_b"), -1);

        let missing = rejected(
            client
                .call(
                    "session.prompt",
                    session_scope("ses_missing"),
                    prompt_request("ses_missing", Some("msg_missing"), "nowhere", false),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        let id = ycoding_core::ycoding_schema::session_message::Id::new("msg_missing").unwrap();
        assert!(world().core.sessions.pending(&id).unwrap().is_none());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn results_wait_for_consumer_credit_and_resume_after_consumption() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), false), standard().unwrap()).await;
        let mut probe = Client::open(server.address(), &[]).await.unwrap();
        probe
            .call(
                "server.get",
                machine(),
                v5::ServerGetRequest {}.encode_to_vec(),
            )
            .await;
        let length = probe.last_frame_len as u64;

        let mut client = Client::open_with(
            server.address(),
            &[],
            ycoding_protocol::connection::Budgets {
                normal_window_bytes: length * 3 / 2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        client.hold = true;
        let mut ids = Vec::new();
        for _ in 0..3 {
            ids.push(
                client
                    .send(
                        "server.get",
                        machine(),
                        v5::ServerGetRequest {}.encode_to_vec(),
                    )
                    .await,
            );
        }
        let (first, first_ordinal) = client.settle_held(&ids[0]).await;
        assert!(matches!(first, Outcome::Success { .. }));
        client.run_for(Duration::from_millis(400)).await;
        assert!(
            client.events.is_empty() && client.close.is_none(),
            "the second result was delivered before the first was consumed"
        );
        client.consume(first_ordinal);
        let (second, second_ordinal) = client.settle_held(&ids[1]).await;
        assert!(matches!(second, Outcome::Success { .. }));
        client.run_for(Duration::from_millis(400)).await;
        assert!(
            client.events.is_empty() && client.close.is_none(),
            "the third result was delivered before the second was consumed"
        );
        client.consume(second_ordinal);
        let (third, _) = client.settle_held(&ids[2]).await;
        assert!(matches!(third, Outcome::Success { .. }));
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispatched_requests_return_receive_credit_to_the_sender() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), false), standard().unwrap()).await;
        let mut probe = Client::open(server.address(), &[]).await.unwrap();
        probe
            .call(
                "server.get",
                machine(),
                v5::ServerGetRequest {}.encode_to_vec(),
            )
            .await;
        let length = probe.last_frame_len as u64;
        let mut client = Client::open_with(
            server.address(),
            &[],
            ycoding_protocol::connection::Budgets {
                normal_window_bytes: length * 3 / 2,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for _ in 0..6 {
            let outcome = client
                .call(
                    "server.get",
                    machine(),
                    v5::ServerGetRequest {}.encode_to_vec(),
                )
                .await;
            assert!(matches!(outcome, Outcome::Success { .. }));
        }
        server.shutdown().await.unwrap();
    })
    .await;
}

struct DropSignal(Option<oneshot::Sender<()>>);

impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(signal) = self.0.take() {
            let _ = signal.send(());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_a_read_aborts_it_and_never_answers_it() {
    bounded(async {
        let mut dispatcher = bare_dispatcher();
        let started = Arc::new(Notify::new());
        let (dropped_tx, dropped_rx) = oneshot::channel();
        let dropped_tx = Arc::new(Mutex::new(Some(dropped_tx)));
        let signal_started = started.clone();
        dispatcher
            .handle("health.get", move |_, _: v5::HealthGetRequest| {
                let started = signal_started.clone();
                let sender = dropped_tx.lock().unwrap().take();
                async move {
                    let _guard = DropSignal(sender);
                    started.notify_one();
                    std::future::pending::<Result<v5::HealthGetResult, Failure>>().await
                }
            })
            .unwrap();
        dispatcher
            .handle("server.get", |_, _: v5::ServerGetRequest| async {
                Ok(v5::ServerGetResult {
                    urls: v5::ServerGetResultUrls {
                        items: vec![text("http://after-cancel")],
                    },
                })
            })
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let id = client
            .send(
                "health.get",
                machine(),
                v5::HealthGetRequest {}.encode_to_vec(),
            )
            .await;
        started.notified().await;
        let now = client.now();
        let settled = client.connection.cancel_request(&id, now).unwrap();
        assert!(matches!(
            settled.as_slice(),
            [ycoding_protocol::connection::Decision::Settled {
                outcome: Outcome::Unknown,
                ..
            }]
        ));
        client.pump().await;
        tokio::time::timeout(Duration::from_secs(5), dropped_rx)
            .await
            .expect("the cancelled read future was dropped")
            .unwrap();
        let urls: v5::ServerGetResult = success(
            client
                .call(
                    "server.get",
                    machine(),
                    v5::ServerGetRequest {}.encode_to_vec(),
                )
                .await,
        );
        assert_eq!(units(&urls.urls.items[0]), "http://after-cancel");
        assert!(
            client.events.is_empty(),
            "the cancelled request produced no later settlement"
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_mutation_completion_after_connection_replacement_reaches_nobody() {
    bounded(async {
        let mut dispatcher = bare_dispatcher();
        let started_a = Arc::new(Notify::new());
        let gate_a = Arc::new(Notify::new());
        let (finished_tx, finished_rx) = oneshot::channel();
        let finished_tx = Arc::new(Mutex::new(Some(finished_tx)));
        let (a_started, a_gate) = (started_a.clone(), gate_a.clone());
        dispatcher
            .handle(
                "session.interrupt",
                move |_, _: v5::SessionInterruptRequest| {
                    let (started, gate) = (a_started.clone(), a_gate.clone());
                    let finished = finished_tx.lock().unwrap().take();
                    async move {
                        started.notify_one();
                        gate.notified().await;
                        if let Some(finished) = finished {
                            let _ = finished.send(());
                        }
                        Ok(v5::SessionInterruptResult { data: v5::Empty {} })
                    }
                },
            )
            .unwrap();
        dispatcher
            .authorize("session.interrupt", |_, _| Ok(()))
            .unwrap();
        let started_b = Arc::new(Notify::new());
        let gate_b = Arc::new(Notify::new());
        let (b_started, b_gate) = (started_b.clone(), gate_b.clone());
        dispatcher
            .handle("server.get", move |_, _: v5::ServerGetRequest| {
                let (started, gate) = (b_started.clone(), b_gate.clone());
                async move {
                    started.notify_one();
                    gate.notified().await;
                    Ok(v5::ServerGetResult {
                        urls: v5::ServerGetResultUrls {
                            items: vec![text("http://replacement")],
                        },
                    })
                }
            })
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;

        let mut first = Client::open(server.address(), &[]).await.unwrap();
        let first_id = first
            .send(
                "session.interrupt",
                session_scope("ses_interrupt"),
                v5::SessionInterruptRequest {
                    params: v5::SessionInterruptRequestParams {
                        session_id: text("ses_interrupt"),
                    },
                }
                .encode_to_vec(),
            )
            .await;
        started_a.notified().await;
        drop(first);

        let mut second = Client::open(server.address(), &[]).await.unwrap();
        let second_id = second
            .send(
                "server.get",
                machine(),
                v5::ServerGetRequest {}.encode_to_vec(),
            )
            .await;
        assert_eq!(first_id, second_id, "both connections reuse request ID 1");
        started_b.notified().await;

        gate_a.notify_one();
        tokio::time::timeout(Duration::from_secs(5), finished_rx)
            .await
            .expect("the admitted mutation ran to completion after its connection ended")
            .unwrap();
        gate_b.notify_one();
        let urls: v5::ServerGetResult = success(second.settle(&second_id).await);
        assert_eq!(units(&urls.urls.items[0]), "http://replacement");
        second.run_for(Duration::from_millis(200)).await;
        assert!(second.events.is_empty() && second.close.is_none());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mutations_run_in_arrival_order_per_session_and_concurrently_across_sessions() {
    bounded(async {
        let mut dispatcher = bare_dispatcher();
        let log = Arc::new(Mutex::new(Vec::<String>::new()));
        let gate = Arc::new(Notify::new());
        let first_started = Arc::new(Notify::new());
        let (handler_log, handler_gate, handler_started) =
            (log.clone(), gate.clone(), first_started.clone());
        dispatcher
            .handle(
                "session.interrupt",
                move |invocation, _: v5::SessionInterruptRequest| {
                    let (log, gate, started) = (
                        handler_log.clone(),
                        handler_gate.clone(),
                        handler_started.clone(),
                    );
                    async move {
                        let Some(v5::scope::Target::Session(session)) =
                            invocation.scope.target.clone()
                        else {
                            return Err(Failure::Invalid("scope".into()));
                        };
                        let first_for_session = {
                            let mut log = log.lock().unwrap();
                            let first =
                                !log.iter().any(|entry| entry == &format!("{session}:start"));
                            log.push(format!("{session}:start"));
                            first
                        };
                        if session == "ses_interrupt" && first_for_session {
                            started.notify_one();
                            gate.notified().await;
                        }
                        log.lock().unwrap().push(format!("{session}:done"));
                        Ok(v5::SessionInterruptResult { data: v5::Empty {} })
                    }
                },
            )
            .unwrap();
        dispatcher
            .authorize("session.interrupt", |_, _| Ok(()))
            .unwrap();
        let server = start(services(LocalAuth::disabled(), false), dispatcher).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let request = |session: &str| {
            v5::SessionInterruptRequest {
                params: v5::SessionInterruptRequestParams {
                    session_id: text(session),
                },
            }
            .encode_to_vec()
        };
        let a1 = client
            .send(
                "session.interrupt",
                session_scope("ses_interrupt"),
                request("ses_interrupt"),
            )
            .await;
        first_started.notified().await;
        let a2 = client
            .send(
                "session.interrupt",
                session_scope("ses_interrupt"),
                request("ses_interrupt"),
            )
            .await;
        let b1 = client
            .send(
                "session.interrupt",
                session_scope("ses_other"),
                request("ses_other"),
            )
            .await;
        let _: v5::SessionInterruptResult = success(client.settle(&b1).await);
        assert_eq!(
            *log.lock().unwrap(),
            ["ses_interrupt:start", "ses_other:start", "ses_other:done"],
            "the second same-Session mutation waits while another Session proceeds"
        );
        gate.notify_one();
        let _: v5::SessionInterruptResult = success(client.settle(&a1).await);
        let _: v5::SessionInterruptResult = success(client.settle(&a2).await);
        assert_eq!(
            *log.lock().unwrap(),
            [
                "ses_interrupt:start",
                "ses_other:start",
                "ses_other:done",
                "ses_interrupt:done",
                "ses_interrupt:start",
                "ses_interrupt:done",
            ]
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_closes_open_connections_with_service_restart() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), false), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let address = server.address();
        server.shutdown().await.unwrap();
        assert_eq!(client.closed().await.0, 1012);
        assert!(tokio::net::TcpStream::connect(address).await.is_err());
    })
    .await;
}

fn interrupt_request(session: &str) -> Vec<u8> {
    v5::SessionInterruptRequest {
        params: v5::SessionInterruptRequestParams {
            session_id: text(session),
        },
    }
    .encode_to_vec()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_interrupt_completes_idle_sessions_and_rejects_unknown_or_mismatched_scope() {
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let _: v5::SessionInterruptResult = success(
            client
                .call(
                    "session.interrupt",
                    session_scope("ses_get"),
                    interrupt_request("ses_get"),
                )
                .await,
        );
        let missing = rejected(
            client
                .call(
                    "session.interrupt",
                    session_scope("ses_nowhere"),
                    interrupt_request("ses_nowhere"),
                )
                .await,
        );
        assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
        assert!(
            operation("session.interrupt")
                .error_types
                .contains(&missing.type_name)
        );
        let mismatched = rejected(
            client
                .call(
                    "session.interrupt",
                    session_scope("ses_get"),
                    interrupt_request("ses_other"),
                )
                .await,
        );
        assert_eq!(mismatched.type_name, v5::InvalidRequestError::full_name());
        server.shutdown().await.unwrap();
    })
    .await;
}
