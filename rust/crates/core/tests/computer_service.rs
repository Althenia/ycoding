#![cfg(unix)]

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::platform::computer::{
    self,
    macos::{Launcher, NativeClient},
    service::{Coordinator, Error},
    types::*,
};

struct ProcessLauncher {
    behavior: &'static str,
    children: Mutex<Vec<tokio::process::Child>>,
    directories: Mutex<Vec<std::path::PathBuf>>,
}

impl Launcher for ProcessLauncher {
    fn launch<'a>(
        &'a self,
        _application: &'a Path,
        request: &'a Path,
        response: Option<&'a Path>,
    ) -> computer::Future<'a, Result<(), NativeError>> {
        Box::pin(async move {
            assert!(response.is_none());
            let mut children = self.children.lock().unwrap();
            let behavior = if self.directories.lock().unwrap().is_empty() {
                self.behavior
            } else {
                "normal"
            };
            children.push(
                tokio::process::Command::new("python3")
                    .arg(
                        Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("tests/fixtures/computer-service.py"),
                    )
                    .arg(request)
                    .arg(behavior)
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap(),
            );
            self.directories
                .lock()
                .unwrap()
                .push(request.parent().unwrap().into());
            Ok(())
        })
    }
}

#[tokio::test]
async fn timed_out_and_version_mismatched_service_processes_are_terminated_and_replaced() {
    use std::os::unix::process::ExitStatusExt;
    for behavior in ["version", "timeout"] {
        let launcher = Arc::new(ProcessLauncher {
            behavior,
            children: Mutex::new(vec![]),
            directories: Mutex::new(vec![]),
        });
        let native = Arc::new(NativeClient::new(
            "darwin",
            "/fixture/app".into(),
            launcher.clone(),
            Duration::from_millis(100),
        ));
        let coordinator = Coordinator::new(native.clone(), "darwin");
        let service = coordinator.service();
        let owner = Owner {
            session_id: "ses_fixture".into(),
            call_id: "launch".into(),
        };
        let error = service
            .execute(Request::launch(
                owner.clone(),
                "com.example.fixture".into(),
                false,
            ))
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            Error::Native(NativeError {
                code: Code::UnknownOutcome,
                outcome: Some(Outcome::Unknown),
                ..
            })
        ));
        let mut first = launcher.children.lock().unwrap().remove(0);
        let status = tokio::time::timeout(Duration::from_secs(2), first.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.signal(), Some(15));
        assert!(!launcher.directories.lock().unwrap()[0].exists());
        assert_eq!(
            service
                .execute(Request::list(owner))
                .await
                .unwrap()
                .revision,
            "rev"
        );
        coordinator.shutdown().await.unwrap();
        native.shutdown().await.unwrap();
        let mut second = launcher.children.lock().unwrap().remove(0);
        assert!(
            tokio::time::timeout(Duration::from_secs(2), second.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
        assert!(
            launcher
                .directories
                .lock()
                .unwrap()
                .iter()
                .all(|directory| !directory.exists())
        );
    }
}
