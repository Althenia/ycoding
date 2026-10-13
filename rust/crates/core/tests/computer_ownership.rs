use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
use ycoding_core::platform::computer::{
    self,
    service::{Coordinator, Invoke},
    types::*,
};

struct Native {
    calls: Mutex<Vec<Request>>,
    results: Mutex<VecDeque<Result<Success, NativeError>>>,
    entered: Notify,
    finished: Notify,
    proceed: Notify,
    hold: std::sync::atomic::AtomicBool,
}
impl Native {
    fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            results: Mutex::new(VecDeque::new()),
            entered: Notify::new(),
            finished: Notify::new(),
            proceed: Notify::new(),
            hold: std::sync::atomic::AtomicBool::new(false),
        }
    }
}
impl Invoke for Native {
    fn invoke<'a>(
        &'a self,
        request: Request,
        _signal: tokio::sync::watch::Receiver<bool>,
    ) -> computer::Future<'a, Result<Success, NativeError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(request.clone());
            if self.hold.load(std::sync::atomic::Ordering::Acquire) {
                self.entered.notify_one();
                self.proceed.notified().await;
                self.finished.notify_one();
            }
            self.results.lock().unwrap().pop_front().unwrap_or_else(|| {
                Ok(Success {
                    action: request.operation,
                    revision: "rev-1".into(),
                    detail: json!({}),
                })
            })
        })
    }
}
fn owner(session: &str, call: &str) -> Owner {
    Owner {
        session_id: session.into(),
        call_id: call.into(),
    }
}
fn target(window: u64) -> Target {
    Target::Desktop {
        bundle_id: "com.example.fixture".into(),
        pid: 451,
        window_id: window,
    }
}
fn click(session: &str, call: &str, revision: &str, window: u64) -> Request {
    Request::act(
        owner(session, call),
        target(window),
        revision.into(),
        Action::Click {
            element: Some(vec![0]),
            x: None,
            y: None,
            button: None,
            count: None,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn exact_inspection_and_location_fences_precede_dispatch() {
    let native = Arc::new(Native::new());
    let coordinator = Coordinator::new(native.clone(), "darwin");
    let first = coordinator.service();
    let second = coordinator.service();
    assert!(
        first
            .execute(click("ses_a", "before", "rev-1", 73))
            .await
            .is_err()
    );
    assert!(native.calls.lock().unwrap().is_empty());
    first
        .execute(Request::inspect(owner("ses_a", "inspect"), target(73)).unwrap())
        .await
        .unwrap();
    for request in [
        click("ses_a", "stale", "rev-0", 73),
        click("ses_b", "foreign", "rev-1", 73),
    ] {
        assert!(first.execute(request).await.is_err());
    }
    assert!(
        second
            .execute(click("ses_a", "location", "rev-1", 73))
            .await
            .is_err()
    );
    assert_eq!(native.calls.lock().unwrap().len(), 1);
    first
        .execute(click("ses_a", "act", "rev-1", 73))
        .await
        .unwrap();
    assert_eq!(native.calls.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn unknown_outcomes_and_native_stale_revisions_require_new_inspection_and_never_replay() {
    for code in [
        Code::UnknownOutcome,
        Code::FocusRestoreFailed,
        Code::InspectorCloseFailed,
        Code::StaleRevision,
        Code::TargetNotFound,
    ] {
        let native = Arc::new(Native::new());
        let coordinator = Coordinator::new(native.clone(), "darwin");
        let service = coordinator.service();
        service
            .execute(Request::inspect(owner("ses_a", "inspect"), target(73)).unwrap())
            .await
            .unwrap();
        native
            .results
            .lock()
            .unwrap()
            .push_back(Err(NativeError::new(
                code,
                "uncertain",
                if code == Code::StaleRevision || code == Code::TargetNotFound {
                    Outcome::NotStarted
                } else {
                    Outcome::Unknown
                },
            )));
        assert!(
            service
                .execute(click("ses_a", "act", "rev-1", 73))
                .await
                .is_err()
        );
        assert!(
            service
                .execute(click("ses_a", "act", "rev-1", 73))
                .await
                .is_err()
        );
        assert_eq!(native.calls.lock().unwrap().len(), 2);
        service
            .execute(Request::inspect(owner("ses_a", "reinspect"), target(73)).unwrap())
            .await
            .unwrap();
        service
            .execute(click("ses_a", "new-act", "rev-1", 73))
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn settled_revision_chains_and_unchanged_is_not_repeated() {
    let native = Arc::new(Native::new());
    let service = Coordinator::new(native.clone(), "darwin").service();
    service
        .execute(Request::inspect(owner("ses_a", "inspect"), target(73)).unwrap())
        .await
        .unwrap();
    native.results.lock().unwrap().push_back(Ok(Success {
        action: Operation::DesktopClick,
        revision: "rev-2".into(),
        detail: json!({"effect":"unchanged"}),
    }));
    let result = service
        .execute(click("ses_a", "act", "rev-1", 73))
        .await
        .unwrap();
    assert_eq!(result.detail["effect"], "unchanged");
    assert!(
        service
            .execute(click("ses_a", "old", "rev-1", 73))
            .await
            .is_err()
    );
    service
        .execute(click("ses_a", "next", "rev-2", 73))
        .await
        .unwrap();
    assert_eq!(native.calls.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn cancel_is_session_and_location_scoped_and_late_success_does_not_restore_claim() {
    let native = Arc::new(Native::new());
    let coordinator = Coordinator::new(native.clone(), "darwin");
    let service = coordinator.service();
    let other = coordinator.service();
    native
        .hold
        .store(true, std::sync::atomic::Ordering::Release);
    let task = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .execute(Request::inspect(owner("ses_a", "call"), target(73)).unwrap())
                .await
        }
    });
    native.entered.notified().await;
    assert!(!other.cancel("ses_a", "call"));
    assert!(!service.cancel("ses_b", "call"));
    assert!(service.cancel("ses_a", "call"));
    native.proceed.notify_one();
    assert!(task.await.unwrap().is_err());
    assert!(
        service
            .execute(click("ses_a", "act", "rev-1", 73))
            .await
            .is_err()
    );
    assert_eq!(native.calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn desktop_focus_mutations_on_distinct_windows_are_serialized() {
    let native = Arc::new(Native::new());
    let service = Coordinator::new(native.clone(), "darwin").service();
    for window in [73, 74] {
        service
            .execute(
                Request::inspect(owner("ses_a", &format!("inspect-{window}")), target(window))
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    native
        .hold
        .store(true, std::sync::atomic::Ordering::Release);
    let first = tokio::spawn({
        let service = service.clone();
        async move { service.execute(click("ses_a", "first", "rev-1", 73)).await }
    });
    native.entered.notified().await;
    let second = tokio::spawn({
        let service = service.clone();
        async move { service.execute(click("ses_a", "second", "rev-1", 74)).await }
    });
    native.proceed.notify_one();
    first.await.unwrap().unwrap();
    native.entered.notified().await;
    native.proceed.notify_one();
    second.await.unwrap().unwrap();
    assert_eq!(native.calls.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn browser_tabs_claim_whole_windows_atomically_and_quit_invalidates_pid_claims() {
    let native = Arc::new(Native::new());
    let coordinator = Coordinator::new(native.clone(), "darwin");
    let service = coordinator.service();
    let other = coordinator.service();
    native.results.lock().unwrap().push_back(Ok(Success {action:Operation::BrowserTabs,revision:"".into(),detail:json!({"browserWindows":[{"window_id":"17","revision":"window-rev","index":1,"tabs":[]} ]})}));
    service
        .execute(Request::browser_tabs(
            owner("ses_a", "tabs"),
            BrowserBundle::Safari,
        ))
        .await
        .unwrap();
    let target = Target::Browser {
        bundle_id: BrowserBundle::Safari,
        window_id: "17".into(),
        tab_index: 2,
    };
    assert!(
        other
            .execute(
                Request::browser_action(
                    owner("ses_a", "foreign-location"),
                    target.clone(),
                    "window-rev".into(),
                    BrowserAction::Reload
                )
                .unwrap()
            )
            .await
            .is_err()
    );
    service
        .execute(
            Request::browser_action(
                owner("ses_a", "reload"),
                target,
                "window-rev".into(),
                BrowserAction::Reload,
            )
            .unwrap(),
        )
        .await
        .unwrap();
    service
        .execute(Request::inspect(owner("ses_a", "inspect"), self::target(73)).unwrap())
        .await
        .unwrap();
    service
        .execute(Request::quit(
            owner("ses_a", "quit"),
            "com.example.fixture".into(),
            451,
        ))
        .await
        .unwrap();
    assert!(
        service
            .execute(click("ses_a", "after-quit", "rev-1", 73))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn unsupported_platform_never_invokes_native() {
    let native = Arc::new(Native::new());
    let service = Coordinator::new(native.clone(), "linux").service();
    assert_eq!(service.status()["state"], "unsupported");
    assert!(
        service
            .execute(Request::list(owner("ses_a", "list")))
            .await
            .is_err()
    );
    assert!(native.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn dropping_the_caller_keeps_native_settlement_owned_until_focus_restore() {
    let native = Arc::new(Native::new());
    let coordinator = Coordinator::new(native.clone(), "darwin");
    let service = coordinator.service();
    service
        .execute(Request::inspect(owner("ses_a", "inspect"), target(73)).unwrap())
        .await
        .unwrap();
    native
        .hold
        .store(true, std::sync::atomic::Ordering::Release);
    let caller = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .execute(click("ses_a", "dropped", "rev-1", 73))
                .await
        }
    });
    native.entered.notified().await;
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    native.proceed.notify_one();
    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        native.finished.notified(),
    )
    .await
    .expect("Native settlement must remain owned after the caller is dropped");
    coordinator.shutdown().await.unwrap();
    assert!(
        service
            .execute(click("ses_a", "retry", "rev-1", 73))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn session_release_invalidates_its_claims_across_every_location() {
    let native = Arc::new(Native::new());
    let coordinator = Coordinator::new(native.clone(), "darwin");
    let first = coordinator.service();
    let second = coordinator.service();
    first
        .execute(Request::inspect(owner("ses_a", "one"), target(73)).unwrap())
        .await
        .unwrap();
    second
        .execute(Request::inspect(owner("ses_a", "two"), target(74)).unwrap())
        .await
        .unwrap();
    first.release_session("ses_a").await.unwrap();
    assert!(
        second
            .execute(click("ses_a", "after-release", "rev-1", 74))
            .await
            .is_err()
    );
    assert_eq!(native.calls.lock().unwrap().len(), 2);
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_mutations_keep_the_target_locked_and_settle_unknown_without_restoring_claims() {
    for operation in [
        Operation::DesktopClick,
        Operation::DesktopLaunch,
        Operation::DesktopQuit,
    ] {
        let native = Arc::new(Native::new());
        let coordinator = Coordinator::new(native.clone(), "darwin");
        let service = coordinator.service();
        service
            .execute(Request::inspect(owner("ses_a", "inspect"), target(73)).unwrap())
            .await
            .unwrap();
        native
            .hold
            .store(true, std::sync::atomic::Ordering::Release);
        let request = match operation {
            Operation::DesktopLaunch => Request::launch(
                owner("ses_a", "mutation"),
                "com.example.fixture".into(),
                false,
            ),
            Operation::DesktopQuit => Request::quit(
                owner("ses_a", "mutation"),
                "com.example.fixture".into(),
                451,
            ),
            _ => click("ses_a", "mutation", "rev-1", 73),
        };
        let task = tokio::spawn({
            let service = service.clone();
            async move { service.execute(request).await }
        });
        native.entered.notified().await;
        assert!(service.cancel("ses_a", "mutation"));
        if operation == Operation::DesktopClick {
            assert!(
                service
                    .execute(Request::inspect(owner("ses_b", "blocked"), target(73)).unwrap())
                    .await
                    .is_err()
            );
        }
        native.proceed.notify_one();
        let computer::service::Error::Native(error) = task.await.unwrap().unwrap_err() else {
            panic!("cancelled mutation must be a native unknown outcome")
        };
        assert_eq!(error.code, Code::UnknownOutcome);
        assert_eq!(error.outcome, Some(Outcome::Unknown));
        if operation != Operation::DesktopLaunch {
            assert!(
                service
                    .execute(click("ses_a", "retry", "rev-1", 73))
                    .await
                    .is_err()
            );
        }
        assert_eq!(native.calls.lock().unwrap().len(), 2);
        coordinator.shutdown().await.unwrap();
    }
}

#[tokio::test]
async fn private_display_is_shared_and_last_unstage_stops_the_display_owner() {
    let native = Arc::new(Native::new());
    let coordinator = Coordinator::new(native.clone(), "darwin");
    let service = coordinator.service();
    for window in [73, 74] {
        service
            .execute(
                Request::inspect(owner("ses_a", &format!("inspect-{window}")), target(window))
                    .unwrap(),
            )
            .await
            .unwrap();
    }
    native.results.lock().unwrap().extend([
        Ok(Success {
            action: Operation::DisplayHold,
            revision: "".into(),
            detail: json!({"display":{"id":81,"x":0,"y":0,"width":1280,"height":800}}),
        }),
        Ok(Success {
            action: Operation::DesktopStage,
            revision: "staged-73".into(),
            detail: json!({"originalFrame":{"x":1,"y":2,"width":300,"height":200}}),
        }),
        Ok(Success {
            action: Operation::DesktopStage,
            revision: "staged-74".into(),
            detail: json!({"originalFrame":{"x":3,"y":4,"width":400,"height":300}}),
        }),
    ]);
    service
        .stage(owner("ses_a", "stage-73"), target(73), "rev-1".into())
        .await
        .unwrap();
    service
        .stage(owner("ses_a", "stage-74"), target(74), "rev-1".into())
        .await
        .unwrap();
    let directory = native
        .calls
        .lock()
        .unwrap()
        .iter()
        .find(|request| request.operation == Operation::DisplayHold)
        .unwrap()
        .fields()["controlDirectory"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        native
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.operation == Operation::DisplayHold)
            .count(),
        1
    );
    service
        .unstage(owner("ses_a", "unstage-73"), target(73))
        .await
        .unwrap();
    assert!(!std::path::Path::new(&directory).join("stop").exists());
    service
        .unstage(owner("ses_a", "unstage-74"), target(74))
        .await
        .unwrap();
    assert!(std::path::Path::new(&directory).join("stop").exists());
    let frames = native
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.operation == Operation::DesktopUnstage)
        .map(|request| request.fields()["originalFrame"].clone())
        .collect::<Vec<_>>();
    assert_eq!(
        frames,
        vec![
            json!({"x":1.0,"y":2.0,"width":300.0,"height":200.0}),
            json!({"x":3.0,"y":4.0,"width":400.0,"height":300.0})
        ]
    );
    coordinator.shutdown().await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
