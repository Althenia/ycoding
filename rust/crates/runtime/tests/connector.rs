mod connector_support;
mod support;

use connector_support::{Command, Relay};
use prost::{Message, Name};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use support::{machine, operation, services, session_scope, text, units, world};
use tokio::sync::Notify;
use ycoding_core::remote::Device;
use ycoding_protocol::{OPERATIONS, connection::Budgets, decode_strict, v5};
use ycoding_runtime::{
    Dispatcher, Environment, LocalAuth, Settled, Subscriptions,
    connector::{
        Connector, Control, Credential, Credentials, Enrolled, Error, Peer, Preference,
        PreferenceFile, Settings, State,
    },
    standard,
};

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

struct Saved(Arc<AtomicBool>);

impl Preference for Saved {
    fn load(&self) -> ycoding_runtime::Boxed<Result<bool, Error>> {
        let value = self.0.load(Ordering::Acquire);
        Box::pin(async move { Ok(value) })
    }
    fn save(&self, value: bool) -> ycoding_runtime::Boxed<Result<(), Error>> {
        self.0.store(value, Ordering::Release);
        Box::pin(async { Ok(()) })
    }
}

struct Access {
    enrolled: String,
    origin: String,
    device: String,
    calls: Arc<AtomicUsize>,
    entered: Arc<Notify>,
    held: Option<Arc<Notify>>,
}

impl Credentials for Access {
    fn enrolled(&self) -> ycoding_runtime::Boxed<Result<Enrolled, Error>> {
        let enrolled = Enrolled::new(&self.enrolled, "device-a".into());
        Box::pin(async move { enrolled })
    }
    fn access(&self) -> ycoding_runtime::Boxed<Result<Credential, Error>> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        self.entered.notify_one();
        let origin = self.origin.clone();
        let device = self.device.clone();
        let held = self.held.clone();
        Box::pin(async move {
            if let Some(held) = held {
                held.notified().await;
            }
            Ok(Credential::new(
                "stand-in-token".into(),
                now() + 60_000,
                origin,
                device,
            ))
        })
    }
}

fn access(relay: &Relay, held: Option<Arc<Notify>>) -> Arc<Access> {
    minted(relay, &relay.origin(), "device-a", held)
}

fn minted(relay: &Relay, origin: &str, device: &str, held: Option<Arc<Notify>>) -> Arc<Access> {
    Arc::new(Access {
        enrolled: relay.origin(),
        origin: origin.into(),
        device: device.into(),
        calls: Arc::new(AtomicUsize::new(0)),
        entered: Arc::new(Notify::new()),
        held,
    })
}

fn unenrolled() -> Device {
    Device::new(&std::env::temp_dir().join("ycoding-connector-unenrolled")).unwrap()
}

fn environment(control: Option<Control>) -> Arc<Environment> {
    let mut services = services(LocalAuth::disabled(), true);
    services.core.as_mut().unwrap().remote = control;
    Arc::new(Environment {
        services,
        urls: Vec::new(),
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    })
}

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "stand-in-token".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

fn request(name: &str, scope: v5::Scope, payload: Vec<u8>) -> v5::Request {
    v5::Request {
        request_id: "request-a".into(),
        operation_id: operation(name).operation_id,
        scope,
        payload,
    }
}

fn result<T: Message + Name + Default>(settled: Option<Settled>) -> T {
    let Some(Settled::Result(result)) = settled else {
        panic!("expected inline result");
    };
    let Some(v5::result::Outcome::Success(payload)) = result.outcome else {
        panic!("expected successful settlement");
    };
    assert_eq!(payload.type_name, T::full_name());
    decode_strict(&payload.payload).unwrap()
}

fn failure(settled: Option<Settled>) -> v5::TypedPayload {
    let Some(Settled::Result(result)) = settled else {
        panic!("expected inline result");
    };
    let Some(v5::result::Outcome::Error(error)) = result.outcome else {
        panic!("expected rejection");
    };
    error
}

fn listing() -> v5::WorkspaceListResult {
    v5::WorkspaceListResult {
        data: v5::WorkspaceListResultData { items: Vec::new() },
    }
}

fn test_dispatcher() -> Dispatcher {
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle("workspace.list", |_, _: v5::WorkspaceListRequest| async {
            Ok(listing())
        })
        .unwrap();
    dispatcher
}

async fn setup(
    dispatcher: Dispatcher,
    access: Arc<Access>,
) -> (Control, Connector, Arc<AtomicBool>) {
    let saved = Arc::new(AtomicBool::new(false));
    let control = Control::load(Arc::new(Saved(saved.clone())), unenrolled()).await;
    let mut settings = Settings::new(access);
    settings.reconnect_initial = Duration::from_millis(30);
    settings.reconnect_max = Duration::from_millis(100);
    settings.conflict_delay = Duration::from_millis(100);
    let connector = Connector::start(
        control.clone(),
        settings,
        environment(Some(control.clone())),
        Arc::new(dispatcher),
    )
    .unwrap();
    control.set(true).await.unwrap();
    (control, connector, saved)
}

async fn wait_state(control: &Control, state: State) {
    let mut observer = control.observe();
    tokio::time::timeout(
        connector_support::WAIT,
        observer.wait_for(|(_, value)| value.state == state),
    )
    .await
    .unwrap()
    .unwrap();
}

#[test]
fn relay_origin_and_authenticated_device_fail_closed_before_transport() {
    let enrolled = Enrolled::new("https://RELAY.invalid:443/", "device-a".into()).unwrap();
    assert_eq!(enrolled.url(), "wss://relay.invalid/ws/v5/agent");
    assert_eq!(
        Enrolled::new("http://127.0.0.1:8787", "device-a".into())
            .unwrap()
            .url(),
        "ws://127.0.0.1:8787/ws/v5/agent"
    );
    assert!(Enrolled::new("https://relay.invalid", String::new()).is_err());
    for origin in [
        "http://relay.invalid",
        "https://user:pass@relay.invalid",
        "https://relay.invalid/path",
        "https://relay.invalid/?token=x",
        "https://relay.invalid/#token",
    ] {
        assert!(Enrolled::new(origin, "device-a".into()).is_err());
    }
    for (origin, device, expires, expected) in [
        (
            "https://other.invalid",
            "device-a",
            now() + 60_000,
            Error::Forbidden,
        ),
        (
            "http://relay.invalid",
            "device-a",
            now() + 60_000,
            Error::Forbidden,
        ),
        (
            "https://relay.invalid",
            "device-b",
            now() + 60_000,
            Error::Forbidden,
        ),
        (
            "https://relay.invalid",
            "device-a",
            now() - 1,
            Error::Unauthorized,
        ),
    ] {
        assert!(
            matches!(Peer::authenticate(&enrolled, &Credential::new("synthetic".into(), expires, origin.into(), device.into()), now()), Err(error) if error == expected)
        );
    }
    assert!(
        Peer::authenticate(
            &enrolled,
            &Credential::new(
                "synthetic".into(),
                now() + 60_000,
                "https://relay.invalid:443".into(),
                "device-a".into()
            ),
            now()
        )
        .is_ok()
    );
}

#[tokio::test]
async fn remote_global_form_selection_is_rejected_before_backend_resolution() {
    let mut settings = services(LocalAuth::disabled(), false);
    settings.core = None;
    let environment = Arc::new(Environment {
        services: settings,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let error = failure(
        standard()
            .unwrap()
            .invoke_remote(
                environment,
                "remote-global-form".into(),
                &peer(),
                request(
                    "session.form.list",
                    v5::Scope {
                        target: Some(v5::scope::Target::GlobalForm(v5::GlobalFormScope {
                            directory: text("/unadvertised"),
                            workspace_id: None,
                        })),
                    },
                    v5::SessionFormListRequest {
                        params: v5::SessionFormListRequestParams {
                            session_id: text("global"),
                        },
                    }
                    .encode_to_vec(),
                ),
            )
            .await,
    );
    assert_eq!(error.type_name, v5::InvalidRequestError::full_name());
}

#[tokio::test]
async fn remote_event_target_must_match_the_authorized_outer_session() {
    let rejected = failure(
        standard()
            .unwrap()
            .invoke_remote(
                environment(None),
                "scope-mismatch".into(),
                &peer(),
                request(
                    "event.subscribe",
                    session_scope("ses_rich"),
                    v5::EventSubscribeRequest {
                        scope: session_scope("ses_other"),
                    }
                    .encode_to_vec(),
                ),
            )
            .await,
    );
    assert_eq!(rejected.type_name, v5::InvalidRequestError::full_name());
    let rejected = decode_strict::<v5::InvalidRequestError>(&rejected.payload).unwrap();
    assert_eq!(units(rejected.kind.as_ref().unwrap()), "forbidden");
    assert_eq!(
        units(&rejected.message),
        "Remote event target must match its Session scope"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connector_assets_deliver_metadata_then_exact_raw_bytes_and_empty_body() {
    let directory = std::env::temp_dir().join(format!("connector-assets-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    support::insert_project("prj_connector_assets", directory.to_str().unwrap()).await;
    support::insert_session_of(
        "prj_connector_assets",
        "ses_connector_assets",
        directory.to_str().unwrap(),
        None,
    )
    .await;
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle_asset(
            "session.attachment.read",
            |_, request: v5::SessionAttachmentReadRequest| async move {
                let bytes = if units(&request.params.digest) == "0".repeat(64) {
                    vec![]
                } else {
                    vec![255; 65537]
                };
                ycoding_protocol::Asset::new(
                    v5::SessionAttachmentReadResult {
                        data: v5::SessionAssetMetadata {
                            mime: text("application/octet-stream"),
                            bytes: bytes.len() as u64,
                        },
                    },
                    bytes,
                )
                .map_err(|error| ycoding_runtime::Failure::Invalid(error.to_string()))
            },
        )
        .unwrap();
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let (control, connector, _) = setup(dispatcher, access(&relay, None)).await;
    let opening = relay.opening().await;
    wait_state(&control, State::On).await;
    for (digest, length) in [("0".repeat(64), 0), ("1".repeat(64), 65537)] {
        let id = opening
            .request(
                operation("session.attachment.read").operation_id,
                session_scope("ses_connector_assets"),
                v5::SessionAttachmentReadRequest {
                    params: v5::SessionAttachmentReadRequestParams {
                        session_id: text("ses_connector_assets"),
                        digest: text(&digest),
                    },
                }
                .encode_to_vec(),
            )
            .await;
        let metadata = relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)).await;
        let Some(v5::frame::Body::Result(result)) = metadata.body else {
            unreachable!()
        };
        let Some(v5::result::Outcome::AssetMetadata(metadata)) = result.outcome else {
            panic!("asset metadata expected")
        };
        assert_eq!(metadata.byte_count, length as u64);
        assert_eq!(units(&metadata.mime), "application/octet-stream");
        let started = relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::BulkStart(start)) if start.request_id == id)).await;
        let Some(v5::frame::Body::BulkStart(start)) = started.body else {
            unreachable!()
        };
        assert_eq!(start.content_kind, v5::ContentKind::Asset as i32);
        assert_eq!(start.byte_count, length as u64);
        let mut bytes = vec![];
        loop {
            let frame = relay
                .matching(opening.generation, |frame| {
                    matches!(
                        &frame.body,
                        Some(v5::frame::Body::BulkPiece(_) | v5::frame::Body::BulkEnd(_))
                    )
                })
                .await;
            match frame.body.unwrap() {
                v5::frame::Body::BulkPiece(piece) => {
                    assert_eq!(piece.transfer_id, start.transfer_id);
                    assert_eq!(piece.offset as usize, bytes.len());
                    bytes.extend(piece.data);
                }
                v5::frame::Body::BulkEnd(end) => {
                    assert_eq!(end.transfer_id, start.transfer_id);
                    assert_eq!(end.byte_count, length as u64);
                    assert!(matches!(
                        end.outcome,
                        Some(v5::bulk_end::Outcome::Success(_))
                    ));
                    break;
                }
                _ => unreachable!(),
            }
        }
        assert_eq!(bytes, vec![255; length]);
    }
    connector.shutdown().await.unwrap();
    relay.shutdown().await;
    std::fs::remove_dir(directory).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn descriptor_roles_close_local_and_remote_dispatch_in_both_directions() {
    let dispatcher = test_dispatcher();
    let request = request(
        "workspace.list",
        machine(),
        v5::WorkspaceListRequest {
            payload: Default::default(),
        }
        .encode_to_vec(),
    );
    assert!(
        dispatcher
            .invoke(environment(None), "local-test".into(), request.clone())
            .await
            .is_none()
    );
    let response: v5::WorkspaceListResult = result(
        dispatcher
            .invoke_remote(environment(None), "remote-test".into(), &peer(), request)
            .await,
    );
    assert!(response.data.items.is_empty());
    for descriptor in OPERATIONS.iter() {
        let remote = descriptor
            .roles
            .contains(&(v5::PeerRole::RemoteClient as i32))
            && descriptor.roles.contains(&(v5::PeerRole::Relay as i32));
        let settled = dispatcher
            .invoke_remote(
                environment(None),
                "remote-test".into(),
                &peer(),
                v5::Request {
                    request_id: "membership".into(),
                    operation_id: descriptor.operation_id,
                    scope: machine(),
                    payload: Vec::new(),
                },
            )
            .await;
        assert_eq!(settled.is_some(), remote, "{}", descriptor.diagnostic_name);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scoped_shared_reads_follow_backend_movement_and_reject_unknown_or_deleted_placement() {
    let root = std::env::temp_dir().join(format!("ycoding-connector-scope-{}", std::process::id()));
    let first = root.join("first");
    let second = root.join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    support::insert_project("prj_connector", first.to_str().unwrap()).await;
    support::insert_session_of(
        "prj_connector",
        "ses_connector_move",
        first.to_str().unwrap(),
        None,
    )
    .await;
    let dispatcher = standard().unwrap();
    let get = || {
        request(
            "session.get",
            session_scope("ses_connector_move"),
            v5::SessionGetRequest {
                params: v5::SessionGetRequestParams {
                    session_id: text("ses_connector_move"),
                },
            }
            .encode_to_vec(),
        )
    };
    let first_result: v5::SessionGetResult = result(
        dispatcher
            .invoke_remote(environment(None), "remote-test".into(), &peer(), get())
            .await,
    );
    assert_eq!(
        units(&first_result.data.location.directory),
        first.to_str().unwrap()
    );
    let directory = second.to_str().unwrap().to_string();
    world()
        .store
        .submit(move |tx| {
            let key = ycoding_core::ycoding_store::tuple_key(&[
                ycoding_core::ycoding_store::KeyPart::String(&"ses_connector_move".into()),
            ]);
            let mut row = tx
                .get::<ycoding_core::ycoding_store::session::SessionTable>(&key)?
                .unwrap();
            row.directory = directory.into();
            ycoding_core::ycoding_store::session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    let moved: v5::SessionGetResult = result(
        dispatcher
            .invoke_remote(environment(None), "remote-test".into(), &peer(), get())
            .await,
    );
    assert_eq!(
        units(&moved.data.location.directory),
        second.to_str().unwrap()
    );
    std::fs::remove_dir(&second).unwrap();
    let rejected = failure(
        dispatcher
            .invoke_remote(environment(None), "remote-test".into(), &peer(), get())
            .await,
    );
    assert_eq!(rejected.type_name, v5::SessionNotFoundError::full_name());
    let missing = failure(
        dispatcher
            .invoke_remote(
                environment(None),
                "remote-test".into(),
                &peer(),
                request(
                    "session.get",
                    session_scope("ses_connector_unknown"),
                    v5::SessionGetRequest {
                        params: v5::SessionGetRequestParams {
                            session_id: text("ses_connector_unknown"),
                        },
                    }
                    .encode_to_vec(),
                ),
            )
            .await,
    );
    assert_eq!(missing.type_name, v5::SessionNotFoundError::full_name());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_remote_controls_validate_boolean_and_persist_last_intent() {
    let saved = Arc::new(AtomicBool::new(false));
    let control = Control::load(Arc::new(Saved(saved.clone())), unenrolled()).await;
    let environment = environment(Some(control.clone()));
    let dispatcher = standard().unwrap();
    let off: v5::RemoteGetResult = result(
        dispatcher
            .invoke(
                environment.clone(),
                "local-test".into(),
                request("remote.get", machine(), Vec::new()),
            )
            .await,
    );
    assert_eq!(off.data.state, 1);
    assert_eq!(off.data.device, None);
    let invalid = failure(
        dispatcher
            .invoke(
                environment.clone(),
                "local-test".into(),
                request("remote.set", machine(), vec![10, 2, 8, 2]),
            )
            .await,
    );
    assert_eq!(invalid.type_name, v5::InvalidRequestError::full_name());
    assert!(!saved.load(Ordering::Acquire));
    let enabled: v5::RemoteSetResult = result(
        dispatcher
            .invoke(
                environment.clone(),
                "local-test".into(),
                request(
                    "remote.set",
                    machine(),
                    v5::RemoteSetRequest {
                        payload: v5::RemoteSetRequestPayload { enabled: true },
                    }
                    .encode_to_vec(),
                ),
            )
            .await,
    );
    assert_eq!(enabled.data.state, 2);
    assert!(saved.load(Ordering::Acquire));
    let previous = control.observe().borrow().0.generation;
    control.set(true).await.unwrap();
    assert_eq!(control.observe().borrow().0.generation, previous);
    let disabled: v5::RemoteSetResult = result(
        dispatcher
            .invoke(
                environment,
                "local-test".into(),
                request(
                    "remote.set",
                    machine(),
                    v5::RemoteSetRequest {
                        payload: v5::RemoteSetRequestPayload { enabled: false },
                    }
                    .encode_to_vec(),
                ),
            )
            .await,
    );
    assert_eq!(disabled.data.state, 1);
    assert_eq!(
        Control::load(Arc::new(Saved(saved)), unenrolled())
            .await
            .status()
            .state,
        State::Off
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn preference_file_is_atomic_private_and_preserves_malformed_data() {
    let directory = std::env::temp_dir().join(format!(
        "ycoding-connector-preference-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("remote-preference.json");
    let preference = PreferenceFile(path.clone());
    preference.save(true).await.unwrap();
    assert!(preference.load().await.unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    std::fs::write(&path, "not JSON").unwrap();
    let control = Control::load(Arc::new(preference), unenrolled()).await;
    assert_eq!(control.status().state, State::Error);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "not JSON");
    control.set(false).await.unwrap();
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "{\"enabled\":false}"
    );
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn outbound_connector_authenticates_negotiates_and_dispatches_without_a_local_socket() {
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let access = access(&relay, None);
    let (control, connector, saved) = setup(test_dispatcher(), access.clone()).await;
    let opening = relay.opening().await;
    wait_state(&control, State::On).await;
    let id = opening
        .request(
            operation("workspace.list").operation_id,
            machine(),
            v5::WorkspaceListRequest {
                payload: Default::default(),
            }
            .encode_to_vec(),
        )
        .await;
    let frame = relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)).await;
    let Some(v5::frame::Body::Result(result)) = frame.body else {
        unreachable!()
    };
    let Some(v5::result::Outcome::Success(payload)) = result.outcome else {
        panic!("request failed");
    };
    assert_eq!(
        decode_strict::<v5::WorkspaceListResult>(&payload.payload).unwrap(),
        listing()
    );
    assert_eq!(
        frame.connection_epoch.as_deref(),
        Some("relay-connection-1")
    );
    assert_eq!(access.calls.load(Ordering::Acquire), 1);
    connector.shutdown().await.unwrap();
    relay.closed(opening.generation).await;
    assert!(saved.load(Ordering::Acquire));
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revision_and_digest_rejections_are_terminal_without_a_legacy_fallback() {
    for (revision, corrupt) in [(4, false), (5, true)] {
        let mut relay = Relay::start(revision, corrupt, Budgets::default()).await;
        let access = access(&relay, None);
        let (control, connector, saved) = setup(test_dispatcher(), access.clone()).await;
        let opening = relay.opening().await;
        wait_state(&control, State::Error).await;
        relay.closed(opening.generation).await;
        assert_eq!(access.calls.load(Ordering::Acquire), 1);
        assert!(saved.load(Ordering::Acquire));
        connector.shutdown().await.unwrap();
        relay.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mismatched_device_or_origin_never_reaches_the_relay_and_late_credentials_cannot_reenable()
{
    let relay = Relay::start(5, false, Budgets::default()).await;
    for wrong in [
        minted(&relay, &relay.origin(), "device-b", None),
        minted(&relay, "https://other.invalid", "device-a", None),
    ] {
        let (control, connector, _) = setup(test_dispatcher(), wrong).await;
        wait_state(&control, State::Error).await;
        assert_eq!(relay.upgrades(), 0);
        connector.shutdown().await.unwrap();
    }
    let held = Arc::new(Notify::new());
    let late = access(&relay, Some(held.clone()));
    let (control, connector, saved) = setup(test_dispatcher(), late.clone()).await;
    tokio::time::timeout(connector_support::WAIT, late.entered.notified())
        .await
        .unwrap();
    control.set(false).await.unwrap();
    held.notify_one();
    connector.shutdown().await.unwrap();
    assert_eq!(relay.upgrades(), 0);
    assert_eq!(control.status().state, State::Off);
    assert!(!saved.load(Ordering::Acquire));
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn established_disconnect_reconnects_and_unknown_mutations_are_never_replayed() {
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let finished = Arc::new(Notify::new());
    let mut dispatcher = test_dispatcher();
    let count = calls.clone();
    let entered = started.clone();
    let resume = release.clone();
    let ended = finished.clone();
    dispatcher
        .handle("keepAwake.set", move |_, _: v5::KeepAwakeSetRequest| {
            let count = count.clone();
            let entered = entered.clone();
            let resume = resume.clone();
            let ended = ended.clone();
            async move {
                count.fetch_add(1, Ordering::AcqRel);
                entered.notify_one();
                resume.notified().await;
                ended.notify_one();
                Ok(v5::KeepAwakeSetResult {
                    data: v5::KeepAwakeStatus {
                        state: 3,
                        message: None,
                    },
                })
            }
        })
        .unwrap();
    let (control, connector, _) = setup(dispatcher, access(&relay, None)).await;
    let first = relay.opening().await;
    wait_state(&control, State::On).await;
    let id = first
        .request(
            operation("keepAwake.set").operation_id,
            machine(),
            v5::KeepAwakeSetRequest {
                payload: v5::KeepAwakeSetRequestPayload { enabled: true },
            }
            .encode_to_vec(),
        )
        .await;
    tokio::time::timeout(connector_support::WAIT, started.notified())
        .await
        .unwrap();
    first.commands.send(Command::Close(1001)).await.unwrap();
    let second = relay.opening().await;
    wait_state(&control, State::On).await;
    let new_id = second
        .request(
            operation("workspace.list").operation_id,
            machine(),
            v5::WorkspaceListRequest {
                payload: Default::default(),
            }
            .encode_to_vec(),
        )
        .await;
    assert_eq!(id, new_id);
    release.notify_one();
    tokio::time::timeout(connector_support::WAIT, finished.notified())
        .await
        .unwrap();
    let frame = relay.matching(second.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == new_id)).await;
    let Some(v5::frame::Body::Result(result)) = frame.body else {
        unreachable!()
    };
    assert_eq!(
        result.operation_id,
        operation("workspace.list").operation_id
    );
    assert_eq!(calls.load(Ordering::Acquire), 1);
    connector.shutdown().await.unwrap();
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_socket_rejects_connector_only_requests_even_when_a_handler_is_wired() {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle("workspace.list", move |_, _: v5::WorkspaceListRequest| {
            count.fetch_add(1, Ordering::AcqRel);
            async { Ok(listing()) }
        })
        .unwrap();
    let server = support::start(services(LocalAuth::disabled(), false), dispatcher).await;
    let mut client = support::Client::open(server.address(), &[]).await.unwrap();
    client.pump().await;
    let frame = v5::Frame {
        revision: 5,
        connection_epoch: Some(client.epoch.clone()),
        ledger: Some(v5::LedgerClass::Normal as i32),
        delivery_ordinal: Some(1),
        tiny_consumed_through: None,
        body: Some(v5::frame::Body::Request(request(
            "workspace.list",
            machine(),
            v5::WorkspaceListRequest {
                payload: Default::default(),
            }
            .encode_to_vec(),
        ))),
    };
    client.socket.send_binary(&frame.encode_to_vec()).await;
    assert_eq!(client.closed().await.0, 1002);
    assert_eq!(calls.load(Ordering::Acquire), 0);
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_cancel_does_not_start_a_mutation_or_block_independent_reads() {
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut dispatcher = test_dispatcher();
    let count = calls.clone();
    let started = entered.clone();
    let resume = release.clone();
    dispatcher
        .handle("keepAwake.set", move |_, _: v5::KeepAwakeSetRequest| {
            let count = count.clone();
            let started = started.clone();
            let resume = resume.clone();
            async move {
                count.fetch_add(1, Ordering::AcqRel);
                started.notify_one();
                resume.notified().await;
                Ok(v5::KeepAwakeSetResult {
                    data: v5::KeepAwakeStatus {
                        state: 3,
                        message: None,
                    },
                })
            }
        })
        .unwrap();
    let (control, connector, _) = setup(dispatcher, access(&relay, None)).await;
    let opening = relay.opening().await;
    wait_state(&control, State::On).await;
    let payload = v5::KeepAwakeSetRequest {
        payload: v5::KeepAwakeSetRequestPayload { enabled: true },
    }
    .encode_to_vec();
    let first = opening
        .request(
            operation("keepAwake.set").operation_id,
            machine(),
            payload.clone(),
        )
        .await;
    tokio::time::timeout(connector_support::WAIT, entered.notified())
        .await
        .unwrap();
    let second = opening
        .request(operation("keepAwake.set").operation_id, machine(), payload)
        .await;
    let cancelled = opening.cancel(second).await;
    relay
        .matching(opening.generation, |frame| {
            frame
                .tiny_consumed_through
                .is_some_and(|ordinal| ordinal >= cancelled)
        })
        .await;
    let read = opening
        .request(
            operation("workspace.list").operation_id,
            machine(),
            v5::WorkspaceListRequest {
                payload: Default::default(),
            }
            .encode_to_vec(),
        )
        .await;
    relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == read)).await;
    release.notify_one();
    relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == first)).await;
    connector.shutdown().await.unwrap();
    assert_eq!(calls.load(Ordering::Acquire), 1);
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bulk_bytes_cross_credit_windows_without_truncation_and_small_results_make_progress() {
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let expected = v5::WorkspaceListResult {
        data: v5::WorkspaceListResultData {
            items: (0..1000)
                .map(|index| v5::ConnectorWorkspace {
                    id: text(&format!("wsp_{index}")),
                    project_id: text("prj_fixture"),
                    directory: text("/recorded-fixture"),
                    workspace_id: None,
                    name: Some(text(&"x".repeat(800))),
                })
                .collect(),
        },
    };
    let encoded = expected.encode_to_vec();
    assert!(encoded.len() > Budgets::default().bulk_window_bytes as usize);
    let response = expected.clone();
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle(
            "workspace.list",
            move |_, request: v5::WorkspaceListRequest| {
                let response = if request.payload.sessions_only == Some(true) {
                    listing()
                } else {
                    response.clone()
                };
                async move { Ok(response) }
            },
        )
        .unwrap();
    let (control, connector, _) = setup(dispatcher, access(&relay, None)).await;
    let opening = relay.opening().await;
    wait_state(&control, State::On).await;
    let large = opening
        .request(
            operation("workspace.list").operation_id,
            machine(),
            v5::WorkspaceListRequest {
                payload: Default::default(),
            }
            .encode_to_vec(),
        )
        .await;
    let started = relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::BulkStart(start)) if start.request_id == large)).await;
    let Some(v5::frame::Body::BulkStart(start)) = started.body else {
        unreachable!()
    };
    assert_eq!(start.byte_count as usize, encoded.len());
    let small = opening
        .request(
            operation("workspace.list").operation_id,
            machine(),
            v5::WorkspaceListRequest {
                payload: v5::WorkspaceListRequestPayload {
                    sessions_only: Some(true),
                },
            }
            .encode_to_vec(),
        )
        .await;
    let mut bytes = Vec::new();
    let mut small_before_end = false;
    loop {
        let frame = relay
            .matching(opening.generation, |frame| {
                matches!(
                    &frame.body,
                    Some(
                        v5::frame::Body::BulkPiece(_)
                            | v5::frame::Body::BulkEnd(_)
                            | v5::frame::Body::Result(_)
                    )
                )
            })
            .await;
        match frame.body.unwrap() {
            v5::frame::Body::Result(result) => {
                assert_eq!(result.request_id, small);
                small_before_end = true;
            }
            v5::frame::Body::BulkPiece(piece) => {
                assert_eq!(piece.transfer_id, start.transfer_id);
                assert_eq!(piece.offset as usize, bytes.len());
                bytes.extend(piece.data);
            }
            v5::frame::Body::BulkEnd(end) => {
                assert_eq!(end.transfer_id, start.transfer_id);
                assert!(matches!(
                    end.outcome,
                    Some(v5::bulk_end::Outcome::Success(_))
                ));
                break;
            }
            _ => unreachable!(),
        }
    }
    assert!(small_before_end);
    assert_eq!(bytes, encoded);
    assert_eq!(
        decode_strict::<v5::WorkspaceListResult>(&bytes).unwrap(),
        expected
    );
    assert!(relay.bulk_credits() > 0);
    connector.shutdown().await.unwrap();
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connection_epoch_and_input_byte_limits_reject_before_domain_dispatch() {
    for oversized in [false, true] {
        let mut relay = Relay::start(5, false, Budgets::default()).await;
        let (control, connector, _) = setup(test_dispatcher(), access(&relay, None)).await;
        let opening = relay.opening().await;
        wait_state(&control, State::On).await;
        let frame = v5::Frame {
            revision: 5,
            connection_epoch: Some(
                if oversized {
                    "relay-connection-1"
                } else {
                    "obsolete-epoch"
                }
                .into(),
            ),
            ledger: Some(v5::LedgerClass::Normal as i32),
            delivery_ordinal: Some(1),
            tiny_consumed_through: None,
            body: Some(v5::frame::Body::Request(request(
                "workspace.list",
                machine(),
                if oversized {
                    vec![0; ycoding_protocol::limits::CLIENT_FRAME_BYTES as usize + 1]
                } else {
                    v5::WorkspaceListRequest {
                        payload: Default::default(),
                    }
                    .encode_to_vec()
                },
            ))),
        };
        opening.commands.send(Command::Raw(frame)).await.unwrap();
        wait_state(&control, State::Error).await;
        connector.shutdown().await.unwrap();
        relay.shutdown().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connector_conflict_has_its_own_backoff_and_disable_cancels_recovery() {
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let (control, connector, _) = setup(test_dispatcher(), access(&relay, None)).await;
    let opening = relay.opening().await;
    wait_state(&control, State::On).await;
    let closed_at = Instant::now();
    opening.commands.send(Command::Close(4409)).await.unwrap();
    let replacement = relay.opening().await;
    assert!(closed_at.elapsed() >= Duration::from_millis(100));
    wait_state(&control, State::On).await;
    replacement
        .commands
        .send(Command::Close(1001))
        .await
        .unwrap();
    wait_state(&control, State::Connecting).await;
    control.set(false).await.unwrap();
    connector.shutdown().await.unwrap();
    assert!(relay.openings.try_recv().is_err());
    assert_eq!(control.status().state, State::Off);
    relay.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_child_admission_rejects_input_but_preserves_btw_and_owning_scope() {
    let directory =
        std::env::temp_dir().join(format!("ycoding-connector-family-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    support::insert_project("prj_connector_family", directory.to_str().unwrap()).await;
    for id in [
        "ses_connector_root",
        "ses_connector_managed",
        "ses_connector_btw",
    ] {
        support::insert_session_of(
            "prj_connector_family",
            id,
            directory.to_str().unwrap(),
            None,
        )
        .await;
    }
    world()
        .store
        .submit(|tx| {
            for id in ["ses_connector_managed", "ses_connector_btw"] {
                let key = ycoding_core::ycoding_store::tuple_key(&[
                    ycoding_core::ycoding_store::KeyPart::String(&id.into()),
                ]);
                let mut row = tx
                    .get::<ycoding_core::ycoding_store::session::SessionTable>(&key)?
                    .unwrap();
                row.parent_id = Some("ses_connector_root".into());
                row.agent = (id == "ses_connector_btw").then(|| "btw".into());
                ycoding_core::ycoding_store::session::SessionTable::put(tx, &row)?;
            }
            Ok(())
        })
        .unwrap()
        .await
        .unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let mut dispatcher = Dispatcher::new(OPERATIONS.clone());
    dispatcher
        .handle("session.compact", move |_, _: v5::SessionCompactRequest| {
            calls.fetch_add(1, Ordering::AcqRel);
            async {
                Err::<v5::SessionCompactResult, _>(ycoding_runtime::Failure::Unavailable(
                    "outside the admission boundary".into(),
                ))
            }
        })
        .unwrap();
    let input = |id| {
        request(
            "session.compact",
            session_scope(id),
            v5::SessionCompactRequest {
                params: v5::SessionCompactRequestParams {
                    session_id: text(id),
                },
                payload: v5::SessionCompactRequestPayload {
                    id: Some(text("cmp_connector")),
                },
            }
            .encode_to_vec(),
        )
    };
    let rejected = failure(
        dispatcher
            .invoke_remote(
                environment(None),
                "remote-test".into(),
                &peer(),
                input("ses_connector_managed"),
            )
            .await,
    );
    let error: v5::InvalidRequestError = decode_strict(&rejected.payload).unwrap();
    assert_eq!(units(&error.kind.unwrap()), "subagent_read_only");
    assert_eq!(count.load(Ordering::Acquire), 0);
    failure(
        dispatcher
            .invoke_remote(
                environment(None),
                "remote-test".into(),
                &peer(),
                input("ses_connector_btw"),
            )
            .await,
    );
    assert_eq!(count.load(Ordering::Acquire), 1);
    let dispatcher = standard().unwrap();
    let mismatched = failure(
        dispatcher
            .invoke_remote(
                environment(None),
                "remote-test".into(),
                &peer(),
                request(
                    "session.get",
                    session_scope("ses_connector_root"),
                    v5::SessionGetRequest {
                        params: v5::SessionGetRequestParams {
                            session_id: text("ses_connector_btw"),
                        },
                    }
                    .encode_to_vec(),
                ),
            )
            .await,
    );
    assert_eq!(mismatched.type_name, v5::InvalidRequestError::full_name());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_control_socket_owns_enable_disable_and_server_lifetime_cleanup() {
    let mut relay = Relay::start(5, false, Budgets::default()).await;
    let saved = Arc::new(AtomicBool::new(false));
    let control = Control::load(Arc::new(Saved(saved.clone())), unenrolled()).await;
    let environment = environment(Some(control.clone()));
    let server = support::start(environment.services.clone(), standard().unwrap()).await;
    let connector = Connector::start(
        control.clone(),
        Settings::new(access(&relay, None)),
        environment,
        Arc::new(test_dispatcher()),
    )
    .unwrap();
    let mut local = support::Client::open(server.address(), &[]).await.unwrap();
    let off: v5::RemoteGetResult =
        support::success(local.call("remote.get", machine(), Vec::new()).await);
    assert_eq!(off.data.state, 1);
    assert_eq!(off.data.device, None);
    let enabled: v5::RemoteSetResult = support::success(
        local
            .call(
                "remote.set",
                machine(),
                v5::RemoteSetRequest {
                    payload: v5::RemoteSetRequestPayload { enabled: true },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert_eq!(enabled.data.state, 2);
    let opening = relay.opening().await;
    wait_state(&control, State::On).await;
    let online: v5::RemoteGetResult =
        support::success(local.call("remote.get", machine(), Vec::new()).await);
    assert_eq!(online.data.state, 3);
    assert_eq!(online.data.device, None);
    let disabled: v5::RemoteSetResult = support::success(
        local
            .call(
                "remote.set",
                machine(),
                v5::RemoteSetRequest {
                    payload: v5::RemoteSetRequestPayload { enabled: false },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert_eq!(disabled.data.state, 1);
    relay.closed(opening.generation).await;
    assert!(!saved.load(Ordering::Acquire));
    connector.shutdown().await.unwrap();
    server.shutdown().await.unwrap();
    relay.shutdown().await;
}
