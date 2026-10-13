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
        response: &'a Path,
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
            tokio::fs::write(response, self.response.to_string())
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
async fn private_handoff_preserves_typed_request_and_removes_settled_files() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let launcher = Arc::new(FakeLauncher {
        requests: requests.clone(),
        response: json!({"status":"ok","action":"desktop.inspect","revision":"rev-1","accessible":false,"elements":[]}),
    });
    let client = NativeClient::new(
        "darwin",
        PathBuf::from("/fixture/YCoding Computer Use.app"),
        launcher,
        Duration::from_secs(1),
    );
    let response = client
        .invoke(Request::inspect(owner(), target()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.revision, "rev-1");
    assert_eq!(response.detail["accessible"], false);
    assert_eq!(
        requests.lock().unwrap()[0],
        json!({"action":"desktop.inspect","owner":{"sessionID":"ses_owner","callID":"call"},"target":{"platform":"macos","application":"desktop","bundleID":"com.example.fixture","pid":451,"windowID":73}})
    );
    client.shutdown().await.unwrap();
}

#[tokio::test]
async fn malformed_mutation_is_unknown_and_read_failure_is_not_started() {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let client = NativeClient::new(
        "darwin",
        PathBuf::from("/fixture/app"),
        Arc::new(FakeLauncher {
            requests: requests.clone(),
            response: json!({"invalid":true}),
        }),
        Duration::from_secs(1),
    );
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
    assert_eq!(requests.lock().unwrap().len(), 2);
    client.shutdown().await.unwrap();
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
