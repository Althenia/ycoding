use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::time::Duration;
use ycoding_core::{
    platform::{
        keep_awake::{Service, macos_inhibitor},
        process::{Command, Input, Output, is_alive},
    },
    ycoding_schema::keep_awake::{LidState, State},
};

fn child() -> Command {
    let mut command = Command::new("/bin/sleep", ["3600"]);
    command.stdin = Input::Ignore;
    command.stdout = Output::Ignore;
    command.stderr = Output::Ignore;
    command
}
fn counted() -> (Service, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let count = calls.clone();
    (
        Service::with_command(
            true,
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                child()
            }),
        ),
        calls,
    )
}
async fn eventually(mut done: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn macos_owner_pid_command_and_unsupported_never_spawn() {
    let command = macos_inhibitor(4242);
    assert_eq!(command.program, "/usr/bin/caffeinate");
    assert_eq!(command.args, ["-i", "-w", "4242"]);
    assert!(matches!(command.stdin, Input::Ignore));
    assert!(matches!(command.stdout, Output::Ignore));
    assert!(matches!(command.stderr, Output::Ignore));
}

#[tokio::test]
async fn unsupported_does_not_create_worker_or_spawn() {
    let service = Service::with_command(false, Arc::new(|| panic!("unsupported platform spawned")));
    assert_eq!(service.get().state, State::Unsupported);
    assert_eq!(service.set(true).await, service.get());
    assert_eq!(service.set(false).await, service.get());
    assert_eq!(
        service.get().message.unwrap().as_str(),
        Some("Keep machine awake is available on macOS only.")
    );
    service.close().await;
}

#[tokio::test]
async fn idempotent_concurrent_enables_serialized_switches_and_owner_close() {
    let (service, count) = counted();
    assert_eq!(service.get().state, State::Off);
    let (a, b, c) = tokio::join!(service.set(true), service.set(true), service.set(true));
    assert_eq!([a.state, b.state, c.state], [State::On; 3]);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    let (off, on) = tokio::join!(service.set(false), service.set(true));
    assert_eq!([off.state, on.state], [State::Off, State::On]);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    service.close().await;
    assert_eq!(service.get().state, State::Off);
    assert_eq!(service.set(true).await.state, State::Off);
}

#[tokio::test]
async fn spawn_failure_redacts_command_and_recovers() {
    let broken = Arc::new(AtomicBool::new(true));
    let failure = broken.clone();
    let service = Service::with_command(
        true,
        Arc::new(move || {
            if failure.load(Ordering::SeqCst) {
                Command::new("/synthetic-private/missing-inhibitor", ["synthetic-secret"])
            } else {
                child()
            }
        }),
    );
    let failed = service.set(true).await;
    assert_eq!(failed.state, State::Error);
    assert_eq!(
        failed.message.unwrap().as_str(),
        Some("The sleep inhibitor could not be started.")
    );
    broken.store(false, Ordering::SeqCst);
    assert_eq!(service.set(true).await.state, State::On);
    assert_eq!(service.set(false).await.state, State::Off);
    service.close().await;
}

#[tokio::test]
async fn early_exit_reports_code_and_disable_resets() {
    let service =
        Service::with_command(true, Arc::new(|| Command::new("/bin/sh", ["-c", "exit 3"])));
    let failed = service.set(true).await;
    assert_eq!(failed.state, State::Error);
    assert_eq!(
        failed.message.unwrap().as_str(),
        Some("The sleep inhibitor stopped unexpectedly (exit code 3).")
    );
    assert_eq!(service.get().state, State::Error);
    assert_eq!(service.set(false).await.state, State::Off);
    service.close().await;
}

struct Fixture {
    path: std::path::PathBuf,
}
impl Fixture {
    fn new(name: &str) -> Self {
        Self {
            path: std::env::temp_dir()
                .join(format!("ycoding-keep-awake-{name}-{}", std::process::id())),
        }
    }
    fn command(&self) -> Command {
        Command::new(
            "/bin/sh",
            [
                "-c".to_string(),
                format!("echo $$ > '{}'; exec /bin/sleep 3600", self.path.display()),
            ],
        )
    }
    async fn pid(&self) -> u32 {
        eventually(|| {
            std::fs::read_to_string(&self.path)
                .is_ok_and(|value| value.trim().parse::<u32>().is_ok())
        })
        .await;
        std::fs::read_to_string(&self.path)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[tokio::test]
async fn unexpected_signal_exit_has_no_rearm_and_recovers_on_request() {
    let fixture = Arc::new(Fixture::new("signal"));
    let command = fixture.clone();
    let count = Arc::new(AtomicUsize::new(0));
    let calls = count.clone();
    let service = Service::with_command(
        true,
        Arc::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
            command.command()
        }),
    );
    assert_eq!(service.set(true).await.state, State::On);
    let pid = fixture.pid().await;
    let mut kill = ycoding_core::platform::process::spawn(Command::new(
        "/bin/kill",
        ["-KILL".to_string(), pid.to_string()],
    ))
    .await
    .unwrap();
    kill.wait().await.unwrap();
    eventually(|| service.get().state == State::Error).await;
    assert_eq!(
        service.get().message.unwrap().as_str(),
        Some("The sleep inhibitor stopped unexpectedly (terminated by a signal).")
    );
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(!is_alive(pid).unwrap());
    assert_eq!(service.set(true).await.state, State::On);
    assert_eq!(count.load(Ordering::SeqCst), 2);
    service.close().await;
}

#[tokio::test]
async fn cancellation_during_grace_reaps_child_and_never_publishes_on() {
    let fixture = Arc::new(Fixture::new("cancel"));
    let command = fixture.clone();
    let service = Service::with_command(true, Arc::new(move || command.command()));
    let starting = service.clone();
    let task = tokio::spawn(async move { starting.set(true).await });
    let pid = fixture.pid().await;
    assert_eq!(service.get().state, State::Off);
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    service.close().await;
    assert_eq!(service.get().state, State::Off);
    assert!(!is_alive(pid).unwrap());
}

#[tokio::test]
async fn dropping_last_owner_and_cancelled_close_both_release_child() {
    for action in ["drop", "close"] {
        let fixture = Arc::new(Fixture::new(action));
        let command = fixture.clone();
        let service = Service::with_command(true, Arc::new(move || command.command()));
        assert_eq!(service.set(true).await.state, State::On);
        let pid = fixture.pid().await;
        if action == "close" {
            let closing = service.clone();
            let task = tokio::spawn(async move { closing.close().await });
            tokio::task::yield_now().await;
            task.abort();
            let _ = task.await;
        }
        drop(service);
        eventually(|| !is_alive(pid).unwrap()).await;
    }
}

#[tokio::test]
async fn cancellation_during_disable_or_close_finishes_termination_before_off() {
    for action in ["disable-delayed", "close-delayed"] {
        let fixture = Arc::new(Fixture::new(action));
        let stopping = Arc::new(Fixture::new(&format!("{action}-stopping")));
        let release = Arc::new(Fixture::new(&format!("{action}-release")));
        let command = fixture.clone();
        let requested = stopping.clone();
        let unblock = release.clone();
        let service = Service::with_command(
            true,
            Arc::new(move || {
                Command::new(
                    "/bin/sh",
                    [
                        "-c".to_string(),
                        format!(
                            "trap 'echo stopping > {}; while [ ! -f {} ]; do /bin/sleep 0.01; done; exit 0' TERM; echo $$ > {}; while :; do /bin/sleep 1; done",
                            requested.path.display(),
                            unblock.path.display(),
                            command.path.display()
                        ),
                    ],
                )
            }),
        );
        assert_eq!(service.set(true).await.state, State::On);
        let pid = fixture.pid().await;
        let closing = service.clone();
        let task = tokio::spawn(async move {
            if action == "disable-delayed" {
                closing.set(false).await;
            } else {
                closing.close().await;
            }
        });
        eventually(|| stopping.path.exists()).await;
        task.abort();
        let _ = task.await;
        assert!(is_alive(pid).unwrap());
        assert_eq!(service.get().state, State::On);
        std::fs::write(&release.path, "release").unwrap();
        eventually(|| service.get().state == State::Off).await;
        assert!(!is_alive(pid).unwrap());
        service.close().await;
    }
}

#[tokio::test]
async fn owner_close_waiting_for_startup_retains_cleanup_when_cancelled() {
    let fixture = Arc::new(Fixture::new("startup-close"));
    let command = fixture.clone();
    let service = Service::with_command(true, Arc::new(move || command.command()));
    let starting = service.clone();
    let startup = tokio::spawn(async move { starting.set(true).await });
    let pid = fixture.pid().await;
    let closing = service.clone();
    let close = tokio::spawn(async move { closing.close().await });
    tokio::task::yield_now().await;
    close.abort();
    let _ = close.await;
    startup.abort();
    let _ = startup.await;
    drop(service);
    eventually(|| !is_alive(pid).unwrap()).await;
}

#[tokio::test]
async fn independent_root_holds_preserve_manual_preference_until_the_last_release() {
    let (service, count) = counted();
    assert_eq!(service.hold("ses_first").await.state, State::On);
    assert_eq!(service.hold("ses_first").await.manual, Some(false));
    assert_eq!(service.hold("ses_second").await.sleep_hold, Some(true));
    assert_eq!(service.set(false).await.state, State::On);
    assert_eq!(service.release("ses_first").await.state, State::On);
    assert_eq!(service.release("ses_missing").await.state, State::On);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert_eq!(service.release("ses_second").await.state, State::Off);
    assert_eq!(service.get().sleep_hold, Some(false));
    service.set(true).await;
    service.hold("ses_third").await;
    assert_eq!(service.get().manual, Some(true));
    assert_eq!(service.release("ses_third").await.state, State::On);
    assert_eq!(service.set(false).await.state, State::Off);
    service.close().await;
}

#[tokio::test]
async fn unsupported_platform_reports_holds_without_claiming_inhibition() {
    let service = Service::with_command(false, Arc::new(|| panic!("unsupported spawned")));
    let held = service.hold("ses_root").await;
    assert_eq!(held.state, State::Unsupported);
    assert_eq!(held.lid, Some(LidState::Unsupported));
    assert_eq!(held.sleep_hold, Some(true));
    assert_eq!(held.manual, Some(false));
    assert_eq!(service.release("ses_root").await.sleep_hold, Some(false));
    service.close().await;
    let fixture = LidFixture::new();
    let service = Service::with_lid(
        false,
        Arc::new(|| panic!("unsupported spawned")),
        fixture.file(),
        Box::new(|_| panic!("unsupported native call")),
        Duration::from_secs(30),
    );
    assert_eq!(service.recover().await.lid, Some(LidState::Unsupported));
    service.close().await;
}

struct LidFixture {
    directory: std::path::PathBuf,
}
impl LidFixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::env::temp_dir().join(format!(
            "ycoding-keep-awake-lid-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        Self { directory }
    }
    fn file(&self) -> std::path::PathBuf {
        self.directory.join("lid.json")
    }
    fn service(&self, apply: impl FnMut(bool) -> LidState + Send + 'static) -> Service {
        Service::with_lid(
            true,
            Arc::new(child),
            self.file(),
            Box::new(apply),
            Duration::from_millis(10),
        )
    }
    fn armed(&self) -> bool {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(self.file()).unwrap()).unwrap();
        value["armed"].as_bool().unwrap()
    }
}
impl Drop for LidFixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

#[tokio::test]
async fn lid_marker_precedes_native_apply_reapplies_and_clears_on_close() {
    let fixture = LidFixture::new();
    let marker = fixture.file();
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let service = fixture.service(move |enabled| {
        if enabled {
            let value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
            assert_eq!(value["armed"], true);
        }
        sent.send(enabled).unwrap();
        if enabled { LidState::On } else { LidState::Off }
    });
    assert_eq!(service.set(true).await.lid, Some(LidState::On));
    assert!(fixture.armed());
    for _ in 0..2 {
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), received.recv())
                .await
                .unwrap(),
            Some(true)
        );
    }
    service.close().await;
    assert_eq!(service.get().lid, Some(LidState::Off));
    assert_eq!(service.get().state, State::Off);
    assert!(!fixture.armed());
}

#[tokio::test]
async fn startup_recovers_an_armed_marker_and_preserves_failed_recovery() {
    for failed in [false, true] {
        let fixture = LidFixture::new();
        std::fs::write(fixture.file(), r#"{"armed":true}"#).unwrap();
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        let service = fixture.service(move |enabled| {
            assert!(!enabled);
            sent.send(()).unwrap();
            if failed {
                LidState::Error
            } else {
                LidState::Off
            }
        });
        service.recover().await;
        assert_eq!(received.try_recv(), Ok(()));
        assert_eq!(service.get().state, State::Off);
        assert_eq!(
            service.get().lid,
            Some(if failed {
                LidState::Error
            } else {
                LidState::Off
            })
        );
        assert_eq!(fixture.armed(), failed);
        service.close().await;
    }
}

#[tokio::test]
async fn lid_errors_and_unsupported_do_not_claim_lid_control_or_hide_idle_success() {
    for lid in [LidState::Error, LidState::Unsupported] {
        let fixture = LidFixture::new();
        let service = fixture.service(move |enabled| if enabled { lid } else { LidState::Off });
        let status = service.set(true).await;
        assert_eq!(status.state, State::On);
        assert_eq!(status.lid, Some(lid));
        if lid == LidState::Error {
            assert!(
                status
                    .message
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .contains("closing the lid may sleep")
            );
            assert!(fixture.armed());
        }
        service.close().await;
        assert!(!fixture.armed());
    }
    let fixture = LidFixture::new();
    std::fs::create_dir(fixture.file()).unwrap();
    let service = fixture.service(|_| panic!("native call without recovery marker"));
    assert_eq!(service.set(true).await.lid, Some(LidState::Error));
    assert_eq!(service.get().state, State::On);
    service.close().await;
}

#[test]
#[ignore = "subprocess lock probe"]
fn lid_lock_process_probe() {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(std::env::var_os("YCODING_LID_TEST_LOCK").unwrap())
        .unwrap();
    assert_eq!(
        file.try_lock().is_ok(),
        std::env::var("YCODING_LID_TEST_AVAILABLE").unwrap() == "true"
    );
}

#[tokio::test]
async fn lid_ownership_is_exclusive_across_processes_and_transfers_after_release() {
    let fixture = LidFixture::new();
    let owner = fixture.service(|enabled| if enabled { LidState::On } else { LidState::Off });
    let contender = fixture.service(|enabled| if enabled { LidState::On } else { LidState::Off });
    assert_eq!(owner.set(true).await.lid, Some(LidState::On));
    let probe = |available: bool| {
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "lid_lock_process_probe"])
            .env(
                "YCODING_LID_TEST_LOCK",
                fixture.file().with_extension("lock"),
            )
            .env("YCODING_LID_TEST_AVAILABLE", available.to_string())
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stdout)
        );
    };
    probe(false);
    let held = contender.set(true).await;
    assert_eq!(held.state, State::On);
    assert_eq!(held.lid, Some(LidState::Held));
    assert!(
        held.message
            .unwrap()
            .as_str()
            .unwrap()
            .contains("another YCoding process")
    );
    contender.set(false).await;
    owner.set(false).await;
    probe(true);
    assert_eq!(contender.set(true).await.lid, Some(LidState::On));
    contender.close().await;
    owner.close().await;
    assert!(!fixture.armed());
}
