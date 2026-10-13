use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::platform::computer::{
    self,
    macos::{Launcher, NativeClient},
    types::*,
};

struct FakeLauncher {
    requests: Arc<Mutex<Vec<serde_json::Value>>>,
    response: serde_json::Value,
}
impl Launcher for FakeLauncher {
    fn launch<'a>(
        &'a self,
        _application: &'a Path,
        request: &'a Path,
        response: Option<&'a Path>,
    ) -> computer::Future<'a, Result<(), NativeError>> {
        Box::pin(async move {
            let bytes = tokio::fs::read(request).await.unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(request).unwrap().permissions().mode() & 0o777,
                    0o600
                );
                assert_eq!(
                    std::fs::metadata(request.parent().unwrap())
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
            }
            self.requests
                .lock()
                .unwrap()
                .push(serde_json::from_slice(&bytes).unwrap());
            tokio::fs::write(
                response.expect("display response file"),
                self.response.to_string(),
            )
            .await
            .unwrap();
            Ok(())
        })
    }
}
fn owner() -> Owner {
    Owner {
        session_id: "ses_owner".into(),
        call_id: "call".into(),
    }
}
fn target() -> Target {
    Target::Desktop {
        bundle_id: "com.example.fixture".into(),
        pid: 451,
        window_id: 73,
    }
}

#[tokio::test]
async fn private_display_handoff_preserves_typed_request_and_removes_settled_files() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let launcher = Arc::new(FakeLauncher {
        requests: requests.clone(),
        response: json!({"status":"ok","action":"display.hold","revision":"rev-1","display":{"id":1,"x":0,"y":0,"width":800,"height":600}}),
    });
    let client = NativeClient::new(
        "darwin",
        PathBuf::from("/fixture/YCoding Computer Use.app"),
        launcher,
        Duration::from_secs(1),
    );
    let response = client
        .invoke(Request::display_hold(
            owner(),
            "/fixture/display".into(),
            std::process::id(),
        ))
        .await
        .unwrap();
    assert_eq!(response.revision, "rev-1");
    assert_eq!(response.detail["display"]["id"], 1);
    assert_eq!(
        requests.lock().unwrap()[0],
        json!({"action":"display.hold","owner":{"sessionID":"ses_owner","callID":"call"},"controlDirectory":"/fixture/display","ownerPID":std::process::id()})
    );
    client.shutdown().await.unwrap();
}

#[tokio::test]
#[cfg(unix)]
async fn malformed_mutation_is_unknown_and_read_failure_is_not_started() {
    let launcher = Arc::new(ServiceLauncher::new(Behavior::InvalidResult));
    let client = service_client(launcher.clone(), Duration::from_secs(1));
    let read = client
        .invoke(Request::inspect(owner(), target()).unwrap())
        .await
        .unwrap_err();
    assert_eq!(read.code, Code::HelperUnavailable);
    assert_eq!(read.outcome, Some(Outcome::NotStarted));
    let mutate = client
        .invoke(
            Request::act(
                owner(),
                target(),
                "rev-1".into(),
                Action::Click {
                    element: None,
                    x: Some(1),
                    y: Some(2),
                    button: None,
                    count: None,
                },
            )
            .unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(mutate.code, Code::UnknownOutcome);
    assert_eq!(mutate.outcome, Some(Outcome::Unknown));
    assert_eq!(launcher.requests.lock().unwrap().len(), 2);
    client.shutdown().await.unwrap();
    launcher.join().await;
}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq)]
enum Behavior {
    Normal,
    InvalidResult,
    Version,
    Disconnect,
    Reconnect,
    Oversize,
    EmptyFrame,
    WrongId,
    WrongVersion,
    InvalidJson,
    RpcError,
    Timeout,
    NativeError,
    MismatchedAction,
}

#[cfg(unix)]
struct ServiceLauncher {
    launches: Mutex<Vec<PathBuf>>,
    requests: Mutex<Vec<serde_json::Value>>,
    messages: Mutex<Vec<serde_json::Value>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    behavior: Behavior,
}

#[cfg(unix)]
impl ServiceLauncher {
    fn new(behavior: Behavior) -> Self {
        Self {
            launches: Mutex::new(vec![]),
            requests: Mutex::new(vec![]),
            messages: Mutex::new(vec![]),
            tasks: Mutex::new(vec![]),
            behavior,
        }
    }

    async fn join(&self) {
        let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
        for task in tasks {
            task.await.unwrap();
        }
    }
}

#[cfg(unix)]
impl Launcher for ServiceLaunch {
    fn launch<'a>(
        &'a self,
        _application: &'a Path,
        request: &'a Path,
        response: Option<&'a Path>,
    ) -> computer::Future<'a, Result<(), NativeError>> {
        Box::pin(async move {
            use std::os::unix::fs::PermissionsExt;
            assert!(response.is_none());
            assert_eq!(request.file_name().unwrap(), "service.json");
            let launch: serde_json::Value =
                serde_json::from_slice(&tokio::fs::read(request).await.unwrap()).unwrap();
            assert_eq!(
                launch,
                json!({"action":"service","controlDirectory":request.parent().unwrap(),"ownerPID":std::process::id()})
            );
            assert_eq!(
                std::fs::metadata(request).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                std::fs::metadata(request.parent().unwrap())
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            let directory = request.parent().unwrap().to_path_buf();
            let first = self.0.launches.lock().unwrap().is_empty();
            self.0.launches.lock().unwrap().push(directory.clone());
            let listener =
                tokio::net::UnixListener::bind(directory.join("computer-use.sock")).unwrap();
            let fixture = self.0.clone();
            self.0.tasks.lock().unwrap().push(tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let behavior = if first || fixture.behavior == Behavior::InvalidResult { fixture.behavior } else { Behavior::Normal };
                let mut disconnected = false;
                let mut rpc_failed = false;
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    loop {
                        let Ok(length) = socket.read_u32_le().await else { return };
                        assert!(length > 0 && length <= 8 * 1024 * 1024);
                        let mut bytes = vec![0; length as usize];
                        socket.read_exact(&mut bytes).await.unwrap();
                        let message: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                        assert_eq!(message["jsonrpc"], "2.0");
                        fixture.messages.lock().unwrap().push(message.clone());
                        let method = message["method"].as_str().unwrap();
                        let result = match method {
                            "ping" => {
                                assert_eq!(message["params"], json!({"clientApiVersion":1}));
                                json!({"serverApiVersion":if behavior == Behavior::Version { 2 } else { 1 }})
                            }
                            "shutdown" => { assert_eq!(message["params"], json!({})); json!("ok") }
                            "request" => {
                                let request = message["params"]["request"].clone();
                                let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
                                assert!(message["params"]["deadlineUnixMilliseconds"].as_u64().unwrap() >= now);
                                fixture.requests.lock().unwrap().push(request.clone());
                                if behavior == Behavior::Disconnect { return; }
                                if behavior == Behavior::Reconnect && !disconnected { disconnected = true; break; }
                                if behavior == Behavior::Timeout { let _ = socket.read_u8().await; return; }
                                if behavior == Behavior::Oversize || behavior == Behavior::EmptyFrame {
                                    socket.write_u32_le(if behavior == Behavior::Oversize { 8 * 1024 * 1024 + 1 } else { 0 }).await.unwrap();
                                    return;
                                }
                                if behavior == Behavior::InvalidJson {
                                    socket.write_all(&[1,0,0,0,b'{']).await.unwrap();
                                    return;
                                }
                                match behavior {
                                    Behavior::InvalidResult => json!({"invalid":true}),
                                    Behavior::NativeError => json!({"status":"error","code":"accessibility_denied","message":"Denied","outcome":"not_started"}),
                                    Behavior::MismatchedAction => json!({"status":"ok","action":"desktop.capture","revision":"rev"}),
                                    _ => json!({"status":"ok","action":request["action"],"revision":"rev","accessible":false,"elements":[]}),
                                }
                            }
                            _ => panic!("unexpected method"),
                        };
                        let id = if method == "request" && behavior == Behavior::WrongId { json!(999) } else { message["id"].clone() };
                        let version = if method == "request" && behavior == Behavior::WrongVersion { "1.0" } else { "2.0" };
                        let response = if method == "request" && behavior == Behavior::RpcError && !rpc_failed {
                            rpc_failed = true;
                            json!({"jsonrpc":version,"id":id,"error":{"code":-32602,"message":"Invalid request"}})
                        } else { json!({"jsonrpc":version,"id":id,"result":result}) };
                        let bytes = response.to_string().into_bytes();
                        let header = (bytes.len() as u32).to_le_bytes();
                        socket.write_all(&header[..2]).await.unwrap();
                        tokio::task::yield_now().await;
                        socket.write_all(&header[2..]).await.unwrap();
                        socket.write_all(&bytes[..2]).await.unwrap();
                        tokio::task::yield_now().await;
                        socket.write_all(&bytes[2..]).await.unwrap();
                        if method == "shutdown" || behavior == Behavior::Version { return; }
                        if method == "request" && matches!(behavior, Behavior::WrongId | Behavior::WrongVersion) { return; }
                    }
                }
            }));
            Ok(())
        })
    }
}

#[cfg(unix)]
struct ServiceLaunch(Arc<ServiceLauncher>);

#[cfg(unix)]
fn service_client(launcher: Arc<ServiceLauncher>, timeout: Duration) -> NativeClient {
    NativeClient::new(
        "darwin",
        "/fixture/YCoding Computer Use.app".into(),
        Arc::new(ServiceLaunch(launcher)),
        timeout,
    )
}

#[cfg(unix)]
fn mutation() -> Request {
    Request::act(
        owner(),
        target(),
        "rev".into(),
        Action::Click {
            element: None,
            x: Some(2),
            y: Some(3),
            button: None,
            count: None,
        },
    )
    .unwrap()
}

#[cfg(unix)]
#[tokio::test]
async fn persistent_service_splits_frames_serializes_callers_and_cleans_up_on_shutdown() {
    let launcher = Arc::new(ServiceLauncher::new(Behavior::Normal));
    let client = service_client(launcher.clone(), Duration::from_secs(1));
    let (a, b, c) = tokio::join!(
        client.invoke(Request::inspect(owner(), target()).unwrap()),
        client.invoke(Request::list(owner())),
        client.invoke(mutation())
    );
    assert_eq!(a.unwrap().revision, "rev");
    assert_eq!(b.unwrap().action, Operation::DesktopList);
    assert_eq!(c.unwrap().action, Operation::DesktopClick);
    assert_eq!(launcher.launches.lock().unwrap().len(), 1);
    let directory = launcher.launches.lock().unwrap()[0].clone();
    assert!(directory.exists());
    assert_eq!(launcher.requests.lock().unwrap().len(), 3);
    assert_eq!(
        launcher.requests.lock().unwrap()[0],
        Request::inspect(owner(), target()).unwrap().encode()
    );
    assert_eq!(
        launcher
            .messages
            .lock()
            .unwrap()
            .iter()
            .map(|m| m["id"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        [1, 2, 3, 4]
    );
    client.shutdown().await.unwrap();
    launcher.join().await;
    assert!(!directory.exists());
    assert_eq!(
        launcher.messages.lock().unwrap().last().unwrap()["method"],
        "shutdown"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn service_failures_never_replay_and_next_inspection_relaunches_lazily() {
    for behavior in [
        Behavior::Version,
        Behavior::Disconnect,
        Behavior::Oversize,
        Behavior::EmptyFrame,
        Behavior::WrongId,
        Behavior::WrongVersion,
        Behavior::InvalidJson,
        Behavior::RpcError,
        Behavior::Timeout,
    ] {
        let launcher = Arc::new(ServiceLauncher::new(behavior));
        let client = service_client(launcher.clone(), Duration::from_millis(100));
        let error = client.invoke(mutation()).await.unwrap_err();
        assert_eq!(error.code, Code::UnknownOutcome);
        assert_eq!(error.outcome, Some(Outcome::Unknown));
        assert_eq!(launcher.launches.lock().unwrap().len(), 1);
        assert_eq!(
            launcher.requests.lock().unwrap().len(),
            usize::from(behavior != Behavior::Version)
        );
        assert_eq!(
            client
                .invoke(Request::inspect(owner(), target()).unwrap())
                .await
                .unwrap()
                .revision,
            "rev"
        );
        assert_eq!(
            launcher.launches.lock().unwrap().len(),
            if behavior == Behavior::RpcError { 1 } else { 2 }
        );
        client.shutdown().await.unwrap();
        launcher.join().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn disconnected_socket_reconnects_to_the_existing_service_without_mutation_replay() {
    let launcher = Arc::new(ServiceLauncher::new(Behavior::Reconnect));
    let client = service_client(launcher.clone(), Duration::from_secs(1));
    assert_eq!(
        client.invoke(mutation()).await.unwrap_err().code,
        Code::UnknownOutcome
    );
    assert_eq!(
        client
            .invoke(Request::inspect(owner(), target()).unwrap())
            .await
            .unwrap()
            .revision,
        "rev"
    );
    assert_eq!(launcher.launches.lock().unwrap().len(), 1);
    assert_eq!(launcher.requests.lock().unwrap().len(), 2);
    assert_eq!(
        launcher
            .messages
            .lock()
            .unwrap()
            .iter()
            .filter(|m| m["method"] == "ping")
            .count(),
        2
    );
    client.shutdown().await.unwrap();
    launcher.join().await;
}

#[cfg(unix)]
#[tokio::test]
async fn service_native_errors_and_mismatched_actions_preserve_their_categories() {
    for (behavior, code, outcome) in [
        (
            Behavior::NativeError,
            Code::AccessibilityDenied,
            Outcome::NotStarted,
        ),
        (
            Behavior::MismatchedAction,
            Code::InvalidResponse,
            Outcome::Unknown,
        ),
    ] {
        let launcher = Arc::new(ServiceLauncher::new(behavior));
        let client = service_client(launcher.clone(), Duration::from_secs(1));
        let error = client.invoke(mutation()).await.unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.outcome, Some(outcome));
        client.shutdown().await.unwrap();
        launcher.join().await;
    }
}

#[tokio::test]
async fn display_handoff_failures_keep_the_separate_display_error_contract() {
    for (response, code, outcome) in [
        (
            json!({"invalid":true}),
            Code::BackgroundUnavailable,
            Outcome::NotStarted,
        ),
        (
            json!({"status":"ok","action":"desktop.inspect","revision":"rev"}),
            Code::InvalidResponse,
            Outcome::Unknown,
        ),
    ] {
        let client = NativeClient::new(
            "darwin",
            "/fixture/app".into(),
            Arc::new(FakeLauncher {
                requests: Arc::new(Mutex::new(vec![])),
                response,
            }),
            Duration::from_secs(1),
        );
        let error = client
            .invoke(Request::display_hold(
                owner(),
                "/fixture/display".into(),
                std::process::id(),
            ))
            .await
            .unwrap_err();
        assert_eq!(error.code, code);
        assert_eq!(error.outcome, Some(outcome));
        client.shutdown().await.unwrap();
    }
}

#[test]
fn native_response_checks_actions_effects_geometry_and_all_error_codes() {
    for effect in ["changed", "unchanged", "unverified"] {
        assert!(
            computer::macos::decode_response(
                &json!({"status":"ok","action":"desktop.click","revision":"rev","effect":effect})
                    .to_string(),
                Operation::DesktopClick
            )
            .is_ok()
        );
    }
    for code in [
        "window_off_space",
        "window_full_screen",
        "window_minimized",
        "app_hidden",
        "focus_restore_failed",
        "inspector_close_failed",
        "stale_revision",
    ] {
        let error = computer::macos::decode_response(
            &json!({"status":"error","code":code,"message":"failure","outcome":"not_started"})
                .to_string(),
            Operation::DesktopClick,
        )
        .unwrap_err();
        assert_eq!(error.code.as_str(), code);
    }
    assert_eq!(
        computer::macos::decode_response(
            &json!({"status":"ok","action":"desktop.capture","revision":"rev"}).to_string(),
            Operation::DesktopClick
        )
        .unwrap_err()
        .code,
        Code::InvalidResponse
    );
    assert!(computer::macos::decode_response(&json!({"status":"ok","action":"desktop.list","revision":"rev","apps":[{"bundle_id":"x","pid":1,"name":"x","is_active":false,"is_hidden":false,"windows":[{"window_id":1,"title":"x","bounds":{"x":0,"y":0,"width":800,"height":500},"on_screen":false,"placement":"other_space"}]}]}).to_string(),Operation::DesktopList).is_ok());
    assert!(
        computer::macos::decode_response(
            &json!({"status":"ok","action":"desktop.launch","revision":"rev","pid":"451"})
                .to_string(),
            Operation::DesktopLaunch
        )
        .is_err()
    );
}

#[test]
fn targets_are_exact_and_browser_claims_are_window_not_tab_scoped() {
    let a = Target::Browser {
        bundle_id: BrowserBundle::Safari,
        window_id: "17".into(),
        tab_index: 1,
    };
    let b = Target::Browser {
        bundle_id: BrowserBundle::Safari,
        window_id: "17".into(),
        tab_index: 2,
    };
    assert_eq!(a.key(), b.key());
    assert_ne!(a.key(), target().key());
    let request = Request::browser_action(
        owner(),
        a,
        "rev".into(),
        BrowserAction::Evaluate {
            script: "'quote'\n\\tail".into(),
        },
    )
    .unwrap();
    assert_eq!(request.encode()["script"], "'quote'\n\\tail");
    assert_eq!(request.encode()["expectedRevision"], "rev");
    assert!(
        Request::act(
            owner(),
            target(),
            "rev".into(),
            Action::SendText {
                text: "hello".into(),
                newline: true
            }
        )
        .is_err()
    );
}

#[test]
fn fuse_record_geometry_and_media_identity_match_the_ts_vectors() {
    use computer::electron::{self, Fuse, Rect};
    for (flags, expected) in [
        ("0001000", Fuse::On),
        ("0000000", Fuse::Off),
        ("000r000", Fuse::Removed),
    ] {
        let mut bytes = b"binarydL7pKGdnNz796PbbjQWNKmHXBZaB9tsX".to_vec();
        bytes.extend_from_slice(&[1, 7]);
        bytes.extend_from_slice(flags.as_bytes());
        assert_eq!(electron::inspect_fuse(&bytes), expected);
        bytes[38] = 2;
        assert_eq!(electron::inspect_fuse(&bytes), Fuse::Absent);
    }
    let bounds = Rect {
        x: 100.,
        y: 200.,
        width: 800.,
        height: 500.,
    };
    let content = Rect {
        x: 100.,
        y: 222.,
        width: 800.,
        height: 478.,
    };
    assert_eq!(
        electron::content_point(bounds, content, 0.5, 20., 30.).unwrap(),
        (40., 38.)
    );
    assert!(electron::content_point(bounds, content, 0.5, 20., 5.).is_err());
    assert!(electron::media_source_window("window:73:0", 73));
    assert!(!electron::media_source_window("window:73:1", 73));
}
