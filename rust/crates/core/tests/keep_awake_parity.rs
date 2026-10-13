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
    ycoding_schema::keep_awake::State,
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
