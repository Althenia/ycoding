use super::{
    cdp, chrome, chrome_target,
    isolated::{ExecutorError, Phase},
};
use crate::platform::{identifier, process};
use serde_json::json;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{oneshot, watch},
    task::JoinHandle,
    time::Instant,
};
use url::Url;

#[derive(Clone)]
pub(super) struct Options {
    pub(super) executable: PathBuf,
    pub(super) temporary_directory: PathBuf,
    pub(super) url: String,
    pub(super) platform: String,
    pub(super) architecture: String,
    pub(super) startup_timeout: Duration,
    pub(super) command_timeout: Duration,
    pub(super) close_timeout: Duration,
    pub(super) exit_grace: Duration,
    pub(super) destruction_timeout: Duration,
    pub(super) settle: Duration,
}
type Started = oneshot::Receiver<Result<Arc<chrome_target::Shared>, ExecutorError>>;
pub(super) struct Owned {
    #[cfg(test)]
    client: Arc<cdp::Client>,
    #[cfg(test)]
    safety: Arc<chrome_target::Safety>,
    page: std::sync::OnceLock<Arc<chrome_target::Shared>>,
    stop: watch::Sender<bool>,
    settled: watch::Receiver<Option<Result<(), ExecutorError>>>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
struct Launch {
    options: Options,
    url: Url,
    root: PathBuf,
    client: Arc<cdp::Client>,
    bridge: tokio::io::DuplexStream,
    stop: watch::Receiver<bool>,
    started: oneshot::Sender<Result<Arc<chrome_target::Shared>, ExecutorError>>,
    deadline: Instant,
    safety: Arc<chrome_target::Safety>,
}
impl Owned {
    pub(super) fn page(&self) -> &Arc<chrome_target::Shared> {
        self.page.get().expect("the lifecycle is ready")
    }
    #[cfg(test)]
    async fn launch(options: Options) -> Result<Self, ExecutorError> {
        let (owned, receive) = Self::begin(options, None)?;
        owned.ready(receive).await
    }
    pub(super) fn begin(
        options: Options,
        cancellation: Option<watch::Receiver<bool>>,
    ) -> Result<(Self, Started), ExecutorError> {
        let url = chrome_target::safe_url(&options.url)?;
        let deadline = Instant::now() + options.startup_timeout;
        let root = options.temporary_directory.join(
            identifier("ycoding-isolated-browser-")
                .map_err(|_| error("Could not allocate an isolated Chrome profile"))?,
        );
        let (client, bridge) = tokio::io::duplex(8192);
        let (read, write) = tokio::io::split(client);
        let client = Arc::new(cdp::Client::connect(read, write, options.command_timeout));
        let safety = Arc::new(chrome_target::Safety::new());
        let (stop, signal) =
            watch::channel(cancellation.as_ref().is_some_and(|signal| *signal.borrow()));
        let (settle, settled) = watch::channel(None);
        let (started, receive) = oneshot::channel();
        let task_stop = stop.clone();
        let task_client = client.clone();
        let task_safety = safety.clone();
        let task = tokio::spawn(async move {
            let cancellation = cancellation.map(|mut signal| {
                tokio::spawn(async move {
                    if signal.wait_for(|cancelled| *cancelled).await.is_ok() {
                        task_stop.send_replace(true);
                    }
                })
            });
            let result = run(Launch {
                options,
                url,
                root,
                client: task_client.clone(),
                bridge,
                stop: signal,
                started,
                deadline,
                safety: task_safety,
            })
            .await;
            if let Some(task) = cancellation {
                task.abort();
                let _ = task.await;
            }
            let client_cleanup = task_client
                .shutdown()
                .await
                .map_err(|_| error("Chrome control client cleanup failed"));
            let result = combine(result, client_cleanup);
            settle.send_replace(Some(result));
        });
        Ok((
            Self {
                #[cfg(test)]
                client,
                #[cfg(test)]
                safety,
                page: std::sync::OnceLock::new(),
                stop,
                settled,
                task: tokio::sync::Mutex::new(Some(task)),
            },
            receive,
        ))
    }
    pub(super) async fn ready(self, receive: Started) -> Result<Self, ExecutorError> {
        match receive
            .await
            .unwrap_or_else(|_| Err(error("Isolated Chrome startup owner failed")))
        {
            Ok(page) => {
                let _ = self.page.set(page);
                Ok(self)
            }
            Err(failure) => {
                self.shutdown().await?;
                Err(failure)
            }
        }
    }
    pub(super) async fn closed(&self) {
        let _ = self
            .settled
            .clone()
            .wait_for(|result| result.is_some())
            .await;
    }
    pub(super) async fn shutdown(&self) -> Result<(), ExecutorError> {
        self.stop.send_replace(true);
        let mut settled = self.settled.clone();
        let result = settled
            .wait_for(|result| result.is_some())
            .await
            .map_err(|_| error("Isolated Chrome cleanup owner failed"))?
            .clone()
            .ok_or_else(|| error("Isolated Chrome cleanup did not settle"))?;
        let mut task = self.task.lock().await;
        if let Some(task) = task.as_mut() {
            task.await
                .map_err(|_| error("Isolated Chrome cleanup task failed"))?;
        }
        *task = None;
        result
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}
pub(super) fn error(message: impl Into<String>) -> ExecutorError {
    ExecutorError {
        message: message.into(),
        phase: Phase::Predispatch,
    }
}
fn combine(
    result: Result<(), ExecutorError>,
    cleanup: Result<(), ExecutorError>,
) -> Result<(), ExecutorError> {
    match (result, cleanup) {
        (Err(mut failure), Err(cleanup)) => {
            failure.message = format!("{}; {}", failure.message, cleanup.message);
            Err(failure)
        }
        (Err(failure), _) | (_, Err(failure)) => Err(failure),
        _ => Ok(()),
    }
}

async fn run(launch: Launch) -> Result<(), ExecutorError> {
    let Launch {
        options,
        url,
        root,
        client,
        bridge,
        mut stop,
        started,
        deadline,
        safety,
    } = launch;
    if !chrome::supported_placement(&options.platform, &options.architecture) {
        let _ = started.send(Err(error(chrome::PLACEMENT_REASON)));
        return Ok(());
    }
    let major = chrome::version(
        &options.executable,
        deadline
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(1)),
        Some(stop.clone()),
    )
    .await;
    if *stop.borrow() || Instant::now() >= deadline || !major.is_some_and(|major| major >= 152) {
        let message = if *stop.borrow() {
            "Isolated Chrome startup was canceled"
        } else if Instant::now() >= deadline {
            "Isolated Chrome startup timed out"
        } else {
            "Isolated Chrome is unavailable"
        };
        let _ = started.send(Err(error(message)));
        return Ok(());
    }
    use std::os::unix::fs::DirBuilderExt;
    let created = std::fs::DirBuilder::new().mode(0o700).create(&root);
    if created.is_err() {
        let _ = started.send(Err(error("Could not create an isolated Chrome profile")));
        return Err(error("Could not create an isolated Chrome profile"));
    }
    let startup = async {
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(root.join("downloads"))
            .map_err(|_| error("Could not create an isolated Chrome download directory"))?;
        if *stop.borrow() || Instant::now() >= deadline {
            return Err(error("Isolated Chrome startup was canceled or timed out"));
        }
        let mut command = process::Command::new(
            options
                .executable
                .to_str()
                .ok_or_else(|| error("Invalid Chrome executable path"))?,
            [
                "--headless=new".to_owned(),
                format!("--user-data-dir={}", root.join("profile").display()),
                "--remote-debugging-pipe".into(),
                "--use-mock-keychain".into(),
                "--no-first-run".into(),
                "--no-default-browser-check".into(),
                "--disable-background-networking".into(),
                "--disable-component-update".into(),
                "--disable-sync".into(),
                "--disable-extensions".into(),
                "--disable-breakpad".into(),
                "--disable-external-intent-requests".into(),
                "--disable-popup-blocking".into(),
                "--deny-permission-prompts".into(),
                "--renderer-process-limit=1".into(),
                "--metrics-recording-only".into(),
                "about:blank".into(),
            ],
        );
        command.stdin = process::Input::Ignore;
        command.stdout = process::Output::Ignore;
        command.stderr = process::Output::Ignore;
        command.detached = true;
        command
            .additional_fds
            .insert(3, process::FdDirection::Input);
        command
            .additional_fds
            .insert(4, process::FdDirection::Output);
        process::spawn(command)
            .await
            .map_err(|_| error("Failed to start isolated Chrome"))
    }
    .await;
    let result = async {
        let mut child = match startup {
            Ok(child) => child,
            Err(failure) => {
                let _ = started.send(Err(failure));
                return Ok(());
            }
        };
        let mut output = child
            .take_output()
            .ok_or_else(|| error("Chrome did not expose its private control pipe"))?;
        let control = child.control();
        let (mut outgoing, mut incoming) = tokio::io::split(bridge);
        let writer_control = control.clone();
        let writer = tokio::spawn(async move {
            let mut buffer = [0; 8192];
            loop {
                let count = outgoing.read(&mut buffer).await?;
                if count == 0 {
                    break;
                }
                writer_control.write_fd(3, buffer[..count].to_vec()).await?;
            }
            Ok::<(), std::io::Error>(())
        });
        let reader = tokio::spawn(async move {
            while let Some(chunk) = output.recv().await {
                if chunk.kind == process::StreamKind::Fd(4) {
                    incoming.write_all(&chunk.bytes).await?;
                }
            }
            incoming.shutdown().await?;
            Ok::<(), std::io::Error>(())
        });
        let cancel = stop.clone();
        let established = tokio::select! {
            biased;
            _ = stop.wait_for(|stop| *stop) => Err(error("Isolated Chrome startup was canceled")),
            result = tokio::time::timeout_at(deadline, async {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let response = client
                    .send(
                        "Browser.getVersion",
                        json!({}),
                        None,
                        None,
                        Some(options.command_timeout.min(remaining)),
                    )
                    .await
                    .map_err(|_| error("Failed to verify isolated Chrome startup"))?;
                let major = response
                    .get("product")
                    .and_then(|value| value.as_str())
                    .and_then(|product| product.strip_prefix("Chrome/"))
                    .and_then(|product| product.split_once('.'))
                    .and_then(|(major, _)| major.parse::<u64>().ok());
                if Instant::now() >= deadline {
                    return Err(error("Isolated Chrome startup timed out"));
                }
                if !major.is_some_and(|major| major >= 152) {
                    return Err(error("Installed Chrome changed during startup"));
                }
                chrome_target::configure(chrome_target::Settings {
                    client: &client,
                    safety: safety.clone(),
                    downloads: &root.join("downloads"),
                    url: &url,
                    command_timeout: options.command_timeout,
                    destruction_timeout: options.destruction_timeout,
                    settle: options.settle,
                    cancel,
                    deadline,
                })
                .await
            }) => result.unwrap_or_else(|_| Err(error("Isolated Chrome startup timed out"))),
        };
        let (ready, mut guard) = match established {
            Ok(guard) => (Ok(guard.page.clone()), Some(guard)),
            Err(failure) => (Err(failure), None),
        };
        let successful = ready.is_ok();
        let _ = started.send(ready);
        if successful {
            let mut fatal = safety.fatal();
            tokio::select! {
                _ = stop.wait_for(|stop| *stop) => {},
                _ = client.closed() => {},
                _ = child.wait() => {},
                _ = fatal.wait_for(|fatal| *fatal) => {},
            }
        }
        if let Some(guard) = guard.as_mut() {
            guard.stop().await;
        }
        if successful && child.is_running() {
            let _ = tokio::time::timeout(options.close_timeout, async {
                if let Some(guard) = &guard {
                    let _ = client
                        .send(
                            "Target.disposeBrowserContext",
                            json!({"browserContextId": guard.browser_context_id}),
                            None,
                            None,
                            None,
                        )
                        .await;
                }
                let _ = client
                    .send("Browser.close", json!({}), None, None, None)
                    .await;
            })
            .await;
        }
        client.close();
        let _ = control.close_fd(3).await;
        let reaped = match tokio::time::timeout(options.exit_grace, child.wait()).await {
            Ok(exit) => exit,
            Err(_) => {
                child
                    .kill(process::KillOptions {
                        signal: process::KillSignal::Term,
                        force_kill_after: Some(Duration::from_millis(500)),
                    })
                    .await
            }
        };
        let swept = child.reap_group(options.exit_grace).await;
        for task in [writer, reader] {
            task.abort();
            match task.await {
                Ok(Ok(())) => {}
                Ok(Err(failure)) if failure.kind() == std::io::ErrorKind::BrokenPipe => {}
                Ok(Err(_)) => return Err(error("Chrome control pump failed")),
                Err(failure) if failure.is_cancelled() => {}
                Err(_) => return Err(error("Chrome control pump failed")),
            }
        }
        reaped.map_err(|_| error("Isolated Chrome could not be reaped"))?;
        swept.map_err(|_| error("Isolated Chrome process group cleanup failed"))
    }
    .await;
    let cleanup = tokio::fs::remove_dir_all(&root)
        .await
        .map_err(|_| error("Isolated Chrome profile cleanup failed"));
    combine(result, cleanup)
}

#[cfg(test)]
mod tests {
    use super::{Duration, Options, Owned, PathBuf, identifier, json};
    use serde_json::Value;
    use std::os::unix::fs::PermissionsExt;
    struct Fixture {
        root: PathBuf,
    }
    impl Fixture {
        fn new(mode: &str) -> Self {
            let root =
                std::env::temp_dir().join(identifier("ycoding-chrome-lifecycle-test-").unwrap());
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("mode"), mode).unwrap();
            std::fs::write(
                root.join("chrome"),
                include_str!("chrome_process_fixture.py"),
            )
            .unwrap();
            std::fs::set_permissions(root.join("chrome"), std::fs::Permissions::from_mode(0o700))
                .unwrap();
            // A concurrent test's fork can briefly inherit the just-written script open for
            // writing, and exec then fails with ETXTBSY until that child execs.
            let ready = (0..2000).any(|_| {
                match std::process::Command::new(root.join("chrome"))
                    .arg("--fixture-ready")
                    .status()
                {
                    Err(failure) if failure.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                        std::thread::sleep(Duration::from_millis(5));
                        false
                    }
                    status => {
                        assert!(status.unwrap().success());
                        true
                    }
                }
            });
            assert!(ready, "fixture script stayed busy");
            Self { root }
        }
        fn with(mode: &str, behavior: Value) -> Self {
            let fixture = Self::new(mode);
            std::fs::write(fixture.root.join("behavior"), behavior.to_string()).unwrap();
            fixture
        }
        fn options(&self) -> Options {
            Options {
                executable: self.root.join("chrome"),
                temporary_directory: self.root.clone(),
                url: "https://example.test/".into(),
                platform: "darwin".into(),
                architecture: "arm64".into(),
                startup_timeout: Duration::from_secs(3),
                command_timeout: Duration::from_secs(1),
                close_timeout: Duration::from_secs(5),
                exit_grace: Duration::from_millis(500),
                destruction_timeout: Duration::from_secs(2),
                settle: Duration::from_millis(150),
            }
        }
        fn commands(&self) -> Vec<Value> {
            std::fs::read_to_string(self.root.join("commands.log"))
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
        fn methods(&self) -> Vec<String> {
            self.commands()
                .iter()
                .map(|command| command["method"].as_str().unwrap().to_owned())
                .collect()
        }
        fn command(&self, method: &str) -> Value {
            self.commands()
                .into_iter()
                .find(|command| command["method"] == method)
                .unwrap_or_else(|| panic!("{method} was not sent"))
        }
        fn assert_cleanup(&self) {
            let record: Value =
                serde_json::from_slice(&std::fs::read(self.root.join("record")).unwrap()).unwrap();
            assert!(!PathBuf::from(record["root"].as_str().unwrap()).exists());
            assert!(!alive(&record["pid"].as_u64().unwrap().to_string()));
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for name in ["record", "probe-pid", "grandchild-pid"] {
                let Ok(contents) = std::fs::read_to_string(self.root.join(name)) else {
                    continue;
                };
                let pid = if name == "record" {
                    serde_json::from_str::<Value>(&contents)
                        .ok()
                        .and_then(|record| record["pid"].as_u64())
                        .map(|pid| pid.to_string())
                } else {
                    Some(contents)
                };
                if let Some(pid) = pid.filter(|pid| !pid.is_empty()) {
                    kill_fixture(&self.root, &pid);
                }
            }
            let removed = std::fs::remove_dir_all(&self.root);
            assert!(removed.is_ok() || std::thread::panicking());
        }
    }
    fn kill_fixture(root: &std::path::Path, pid: &str) {
        let command = std::process::Command::new("/bin/ps")
            .args(["-o", "command=", "-p", pid])
            .output()
            .unwrap();
        if !String::from_utf8_lossy(&command.stdout).contains(root.to_str().unwrap()) {
            return;
        }
        for target in [format!("-{pid}"), pid.to_owned()] {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", "--", target.as_str()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
    async fn eventually(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("condition was not reached");
    }
    async fn emit(owner: &Owned, events: Value) {
        owner
            .client
            .send("Test.emit", json!({"events": events}), None, None, None)
            .await
            .unwrap();
    }
    async fn settles(owner: &Owned) {
        let mut settled = owner.settled.clone();
        tokio::time::timeout(
            Duration::from_secs(10),
            settled.wait_for(|result| result.is_some()),
        )
        .await
        .unwrap()
        .unwrap();
    }
    fn attached(session: &str, target: &str, kind: &str, opener: &str, waiting: bool) -> Value {
        json!({"method": "Target.attachedToTarget", "params": {
            "sessionId": session,
            "waitingForDebugger": waiting,
            "targetInfo": {"targetId": target, "type": kind, "openerId": opener, "browserContextId": "ctx-1"},
        }})
    }
    fn paused(session: &str, id: &str, url: &str, kind: &str, frame: &str) -> Value {
        json!({"method": "Fetch.requestPaused", "sessionId": session, "params": {
            "requestId": id, "request": {"url": url}, "resourceType": kind, "frameId": frame,
        }})
    }
    async fn bounded(test: impl std::future::Future<Output = ()>) {
        tokio::time::timeout(Duration::from_secs(20), test)
            .await
            .expect("lifecycle test exceeded 20 seconds");
    }
    #[tokio::test]
    async fn startup_deadline_covers_the_probe_and_private_pipe_handshake() {
        bounded(async {
            let fixture = Fixture::new("deadline");
            let mut options = fixture.options();
            options.startup_timeout = Duration::from_secs(4);
            options.command_timeout = Duration::from_secs(6);
            let result = Owned::launch(options).await;
            assert!(
                result.is_err(),
                "startup must use one deadline, not one per phase"
            );
            fixture.assert_cleanup();
        })
        .await;
    }
    fn profile_directories(fixture: &Fixture) -> Vec<PathBuf> {
        std::fs::read_dir(&fixture.root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("ycoding-isolated-browser-")
            })
            .collect()
    }
    fn alive(pid: &str) -> bool {
        std::process::Command::new("/bin/kill")
            .args(["-0", pid])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success()
    }
    #[tokio::test]
    async fn startup_deadline_bounds_a_hung_version_probe_before_any_profile_exists() {
        bounded(async {
            let fixture = Fixture::new("probe-ignore-term");
            let mut options = fixture.options();
            options.startup_timeout = Duration::from_secs(1);
            let started = std::time::Instant::now();
            let failure = tokio::time::timeout(Duration::from_secs(4), Owned::launch(options))
                .await
                .unwrap()
                .err()
                .unwrap();
            assert_eq!(failure.message, "Isolated Chrome startup timed out");
            assert!(started.elapsed() < Duration::from_secs(3));
            assert!(profile_directories(&fixture).is_empty());
        })
        .await;
    }
    #[tokio::test]
    async fn canceled_version_probe_that_ignores_term_is_killed_and_reaped() {
        bounded(async {
            let fixture = Fixture::new("probe-ignore-term");
            let mut options = fixture.options();
            options.startup_timeout = Duration::from_secs(30);
            let (cancel, signal) = tokio::sync::watch::channel(false);
            let (owner, started) = Owned::begin(options, Some(signal)).unwrap();
            let launch = tokio::spawn(owner.ready(started));
            let pid = tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    match std::fs::read_to_string(fixture.root.join("probe-pid")) {
                        Ok(pid) if !pid.is_empty() => return pid,
                        _ => tokio::time::sleep(Duration::from_millis(10)).await,
                    }
                }
            })
            .await
            .unwrap();
            assert!(alive(&pid));
            cancel.send_replace(true);
            let failure = tokio::time::timeout(Duration::from_secs(3), launch)
                .await
                .unwrap()
                .unwrap()
                .err()
                .unwrap();
            assert_eq!(failure.message, "Isolated Chrome startup was canceled");
            assert!(!alive(&pid));
            assert!(profile_directories(&fixture).is_empty());
        })
        .await;
    }
    #[tokio::test]
    async fn canceled_startup_and_dropped_startup_caller_join_cleanup() {
        bounded(async {
            for drop_caller in [false, true] {
                let fixture = Fixture::new("hang");
                let (cancel, signal) = tokio::sync::watch::channel(false);
                let mut options = fixture.options();
                options.startup_timeout = Duration::from_secs(30);
                options.command_timeout = Duration::from_secs(30);
                let (owner, started) = Owned::begin(options, Some(signal)).unwrap();
                let mut events = owner.client.subscribe();
                let mut settled = owner.settled.clone();
                let task = tokio::spawn(owner.ready(started));
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(3), events.recv())
                        .await
                        .unwrap()
                        .unwrap()
                        .method,
                    "Test.handshake"
                );
                if drop_caller {
                    task.abort();
                    assert!(matches!(task.await,Err(failure) if failure.is_cancelled()));
                } else {
                    cancel.send_replace(true);
                    assert!(task.await.unwrap().is_err());
                }
                tokio::time::timeout(
                    Duration::from_secs(3),
                    settled.wait_for(|result| result.is_some()),
                )
                .await
                .unwrap()
                .unwrap();
                fixture.assert_cleanup();
            }
        })
        .await;
    }
    #[tokio::test]
    async fn post_allocation_spawn_failure_removes_the_owned_profile() {
        bounded(async {
            let fixture = Fixture::new("spawn-failure");
            let failure = Owned::launch(fixture.options()).await.err().unwrap();
            assert_eq!(failure.message, "Failed to start isolated Chrome");
            assert!(profile_directories(&fixture).is_empty());
        })
        .await;
    }
    #[tokio::test]
    async fn ignored_term_is_forced_and_reaped_before_shutdown_settles() {
        bounded(async {
            let fixture = Fixture::new("ignore-term");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let record: Value =
                serde_json::from_slice(&std::fs::read(fixture.root.join("record")).unwrap())
                    .unwrap();
            assert_eq!(record["pid"], record["group"]);
            tokio::time::timeout(Duration::from_secs(6), owner.shutdown())
                .await
                .unwrap()
                .unwrap();
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn drop_signals_the_retained_owner_and_cleanup_failure_is_visible() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let mut settled = owner.settled.clone();
            drop(owner);
            tokio::time::timeout(
                Duration::from_secs(3),
                settled.wait_for(|result| result.is_some()),
            )
            .await
            .unwrap()
            .unwrap();
            fixture.assert_cleanup();
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let record: Value =
                serde_json::from_slice(&std::fs::read(fixture.root.join("record")).unwrap())
                    .unwrap();
            let profile = PathBuf::from(record["root"].as_str().unwrap());
            std::fs::remove_dir_all(&profile).unwrap();
            std::fs::write(&profile, "not a directory").unwrap();
            let failure = owner.shutdown().await.unwrap_err();
            assert_eq!(failure.message, "Isolated Chrome profile cleanup failed");
            assert_eq!(owner.shutdown().await.unwrap_err(), failure);
        })
        .await;
    }
    #[tokio::test]
    async fn startup_rechecks_version_and_reaps_changed_or_hung_child() {
        bounded(async {
            for mode in ["changed", "hang"] {
                let fixture = Fixture::new(mode);
                assert!(Owned::launch(fixture.options()).await.is_err(), "{mode}");
                fixture.assert_cleanup();
            }
        })
        .await;
    }
    #[tokio::test]
    async fn private_pipe_flags_profile_permissions_and_joined_shutdown_match_ts() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let record: Value =
                serde_json::from_slice(&std::fs::read(fixture.root.join("record")).unwrap())
                    .unwrap();
            assert_eq!(record["permissions"], 448);
            let args = record["args"].as_array().unwrap();
            for flag in [
                "--headless=new",
                "--remote-debugging-pipe",
                "--use-mock-keychain",
                "--deny-permission-prompts",
                "--disable-extensions",
                "--disable-external-intent-requests",
                "--disable-popup-blocking",
                "about:blank",
            ] {
                assert!(args.contains(&json!(flag)));
            }
            assert_eq!(
                owner
                    .client
                    .send("Browser.getVersion", json!({}), None, None, None)
                    .await
                    .unwrap()["product"],
                "Chrome/152.0.0"
            );
            owner.shutdown().await.unwrap();
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn spontaneous_child_exit_and_disconnected_pipe_cleanup_without_an_operator() {
        bounded(async {
            for mode in ["Test.exit", "Test.disconnect"] {
                let fixture = Fixture::new("normal");
                let owner = Owned::launch(fixture.options()).await.unwrap();
                let _ = owner.client.send(mode, json!({}), None, None, None).await;
                let mut settled = owner.settled.clone();
                tokio::time::timeout(
                    Duration::from_secs(3),
                    settled.wait_for(|result| result.is_some()),
                )
                .await
                .unwrap_or_else(|failure| panic!("{mode}: {failure}"))
                .unwrap();
                owner.shutdown().await.unwrap();
                fixture.assert_cleanup();
            }
        })
        .await;
    }
    #[tokio::test]
    async fn helper_processes_in_the_browser_group_are_reaped_on_every_exit_path() {
        bounded(async {
            for (mode, crash) in [("normal", false), ("ignore-term", false), ("normal", true)] {
                let fixture = Fixture::with(mode, json!({"grandchild": true}));
                let owner = Owned::launch(fixture.options()).await.unwrap();
                let helper = std::fs::read_to_string(fixture.root.join("grandchild-pid")).unwrap();
                assert!(alive(&helper));
                if crash {
                    let _ = owner
                        .client
                        .send("Test.exit", json!({}), None, None, None)
                        .await;
                }
                owner.shutdown().await.unwrap();
                eventually(|| !alive(&helper)).await;
                fixture.assert_cleanup();
            }
        })
        .await;
    }
    #[tokio::test]
    async fn unsupported_placement_and_unsafe_pages_launch_nothing() {
        bounded(async {
            for (platform, architecture, url, message) in [
                (
                    "linux",
                    "arm64",
                    "https://example.test/",
                    "Isolated browser requires macOS arm64",
                ),
                (
                    "darwin",
                    "x86_64",
                    "https://example.test/",
                    "Isolated browser requires macOS arm64",
                ),
                (
                    "darwin",
                    "arm64",
                    "file:///etc/passwd",
                    "Only credential-free HTTP and HTTPS pages are supported",
                ),
                (
                    "darwin",
                    "arm64",
                    "https://user:secret@example.test/",
                    "Only credential-free HTTP and HTTPS pages are supported",
                ),
            ] {
                let fixture = Fixture::new("normal");
                let mut options = fixture.options();
                options.platform = platform.into();
                options.architecture = architecture.into();
                options.url = url.into();
                let failure = Owned::launch(options).await.err().unwrap();
                assert_eq!(failure.message, message, "{platform} {architecture} {url}");
                assert!(!fixture.root.join("probes").exists());
                assert!(!fixture.root.join("record").exists());
                assert!(profile_directories(&fixture).is_empty());
            }
        })
        .await;
    }
    #[tokio::test]
    async fn launch_installs_every_gate_before_any_navigation() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let methods = fixture.methods();
            assert_eq!(
                methods[..3],
                [
                    "Browser.getVersion",
                    "Target.createBrowserContext",
                    "Browser.setDownloadBehavior"
                ]
            );
            assert_eq!(methods[3..5], ["Browser.setPermission"; 2]);
            assert_eq!(methods[5..7], ["Target.createTarget", "Target.attachToTarget"]);
            let mut enabled = methods[7..12].to_vec();
            enabled.sort();
            assert_eq!(
                enabled,
                [
                    "Accessibility.enable",
                    "DOM.enable",
                    "Inspector.enable",
                    "Page.enable",
                    "Page.setInterceptFileChooserDialog"
                ]
            );
            assert_eq!(
                methods[12..16],
                [
                    "Page.getFrameTree",
                    "Fetch.enable",
                    "Target.setDiscoverTargets",
                    "Target.setAutoAttach"
                ]
            );
            assert_eq!(methods[16], "Page.navigate");
            assert_eq!(
                fixture.command("Page.navigate")["params"],
                json!({"url": "https://example.test/"})
            );
            assert_eq!(
                fixture.command("Fetch.continueRequest")["params"]["requestId"],
                "navigation-1"
            );
            assert_eq!(
                methods.iter().filter(|method| *method == "Page.navigate").count(),
                1
            );
            let record: Value =
                serde_json::from_slice(&std::fs::read(fixture.root.join("record")).unwrap()).unwrap();
            let download = fixture.command("Browser.setDownloadBehavior");
            assert_eq!(
                download["params"],
                json!({
                    "behavior": "deny",
                    "browserContextId": "ctx-1",
                    "downloadPath": PathBuf::from(record["root"].as_str().unwrap()).join("downloads"),
                    "eventsEnabled": true,
                })
            );
            let mut denied = fixture
                .commands()
                .iter()
                .filter(|command| command["method"] == "Browser.setPermission")
                .map(|command| command["params"].clone())
                .collect::<Vec<_>>();
            denied.sort_by_key(|params| params["permission"]["name"].to_string());
            assert_eq!(
                denied,
                ["clipboard-read", "clipboard-write"].map(|name| json!({
                    "permission": {"name": name},
                    "setting": "denied",
                    "origin": "https://example.test",
                    "browserContextId": "ctx-1",
                }))
            );
            assert_eq!(
                fixture.command("Target.createTarget")["params"],
                json!({"url": "about:blank", "browserContextId": "ctx-1"})
            );
            assert_eq!(
                fixture.command("Target.attachToTarget")["params"],
                json!({"targetId": "target-main", "flatten": true})
            );
            let intercept = fixture.command("Fetch.enable");
            assert_eq!(intercept["sessionId"], "session-main");
            assert_eq!(
                intercept["params"],
                json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}]})
            );
            assert_eq!(
                fixture.command("Target.setAutoAttach")["params"],
                json!({
                    "autoAttach": true,
                    "waitForDebuggerOnStart": true,
                    "flatten": true,
                    "filter": [{"type": "page", "exclude": false}, {"exclude": true}],
                })
            );
            assert!(owner.safety.failure().is_none());
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn a_failing_gate_stops_launch_before_the_next_step_and_cleans_up() {
        bounded(async {
            for (refused, absent) in [
                ("Browser.setDownloadBehavior", "Target.createTarget"),
                ("Browser.setPermission", "Target.createTarget"),
                ("Target.attachToTarget", "Fetch.enable"),
                ("Fetch.enable", "Target.setAutoAttach"),
            ] {
                let fixture = Fixture::with("normal", json!({"fail": [refused]}));
                let failure = Owned::launch(fixture.options()).await.err().unwrap();
                assert_eq!(
                    failure.message, "Failed to configure isolated Chrome",
                    "{refused}"
                );
                let methods = fixture.methods();
                assert!(methods.iter().any(|method| method == refused));
                assert!(!methods.iter().any(|method| method == absent), "{refused}");
                assert!(!methods.iter().any(|method| method == "Page.navigate"));
                fixture.assert_cleanup();
            }
        })
        .await;
    }
    #[tokio::test]
    async fn a_contained_popup_is_disabled_intercepted_resumed_and_destroyed() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([attached(
                    "popup-session",
                    "popup-target",
                    "page",
                    "target-main",
                    true
                )]),
            )
            .await;
            eventually(|| {
                fixture
                    .methods()
                    .contains(&"Runtime.runIfWaitingForDebugger".into())
            })
            .await;
            emit(
                &owner,
                json!([paused(
                    "popup-session",
                    "popup-request",
                    "https://evil.test/",
                    "Document",
                    "popup-frame"
                )]),
            )
            .await;
            eventually(|| owner.safety.popups() == 1).await;
            let commands = fixture.commands();
            let steps = commands
                .iter()
                .filter(|command| {
                    command["sessionId"] == "popup-session"
                        || command["method"] == "Target.closeTarget"
                })
                .map(|command| {
                    (
                        command["method"].as_str().unwrap().to_owned(),
                        command["sessionId"].as_str().map(str::to_owned),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(
                steps,
                [
                    (
                        "Emulation.setScriptExecutionDisabled".to_owned(),
                        Some("popup-session".to_owned())
                    ),
                    ("Fetch.enable".to_owned(), Some("popup-session".to_owned())),
                    (
                        "Runtime.runIfWaitingForDebugger".to_owned(),
                        Some("popup-session".to_owned())
                    ),
                    ("Target.closeTarget".to_owned(), None),
                ]
            );
            assert_eq!(
                fixture.command("Emulation.setScriptExecutionDisabled")["params"],
                json!({"value": true})
            );
            assert_eq!(
                fixture.command("Target.closeTarget")["params"],
                json!({"targetId": "popup-target"})
            );
            assert!(owner.safety.failure().is_none());
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn unacknowledged_target_destruction_fails_closed_and_stops_the_browser() {
        bounded(async {
            let fixture = Fixture::with("normal", json!({"no_destroy_ack": true}));
            let mut options = fixture.options();
            options.destruction_timeout = Duration::from_millis(200);
            let owner = Owned::launch(options).await.unwrap();
            emit(
                &owner,
                json!([attached(
                    "popup-session",
                    "popup-target",
                    "page",
                    "target-main",
                    true
                )]),
            )
            .await;
            settles(&owner).await;
            assert_eq!(
                owner.safety.failure().as_deref(),
                Some("An unexpected browser target could not be contained")
            );
            assert_eq!(owner.safety.popups(), 0);
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn unexpected_targets_are_closed_exactly_without_popup_handling() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([
                    attached(
                        "stray-session",
                        "stray-worker",
                        "service_worker",
                        "target-main",
                        true
                    ),
                    attached("other-session", "other-page", "page", "someone-else", true),
                ]),
            )
            .await;
            eventually(|| {
                fixture
                    .commands()
                    .iter()
                    .filter(|command| command["method"] == "Target.closeTarget")
                    .count()
                    == 2
            })
            .await;
            let closed = fixture
                .commands()
                .iter()
                .filter(|command| command["method"] == "Target.closeTarget")
                .map(|command| command["params"]["targetId"].clone())
                .collect::<Vec<_>>();
            assert_eq!(closed, ["stray-worker", "other-page"]);
            assert!(
                !fixture
                    .methods()
                    .contains(&"Emulation.setScriptExecutionDisabled".into())
            );
            assert_eq!(owner.safety.popups(), 0);
            assert!(owner.safety.failure().is_none());
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn a_crashed_controllable_target_is_fatal_and_cleaned_up() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([{"method": "Inspector.targetCrashed", "sessionId": "session-main", "params": {}}]),
            )
            .await;
            settles(&owner).await;
            assert_eq!(
                owner.safety.failure().as_deref(),
                Some("The controllable browser target crashed")
            );
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn downloads_and_file_choosers_are_recorded_without_stopping_the_browser() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([
                    {"method": "Browser.downloadWillBegin", "params": {"url": "https://example.test/a"}},
                    {"method": "Page.fileChooserOpened", "sessionId": "session-main", "params": {}},
                ]),
            )
            .await;
            eventually(|| owner.safety.downloads() == 1 && owner.safety.failure().is_some()).await;
            assert_eq!(
                owner.safety.failure().as_deref(),
                Some("File selection is unsupported")
            );
            assert!(owner.settled.borrow().is_none());
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn main_session_requests_are_limited_to_the_approved_origin() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([
                    paused(
                        "session-main",
                        "allowed",
                        "https://example.test/",
                        "Document",
                        "frame-main"
                    ),
                    paused(
                        "session-main",
                        "script",
                        "https://cdn.test/app.js",
                        "Script",
                        "frame-main"
                    ),
                    paused(
                        "session-main",
                        "foreign",
                        "https://evil.test/",
                        "Document",
                        "frame-main"
                    ),
                ]),
            )
            .await;
            eventually(|| owner.safety.failure().is_some()).await;
            eventually(|| {
                fixture
                    .commands()
                    .iter()
                    .filter(|command| command["method"] == "Fetch.continueRequest")
                    .count()
                    == 3
            })
            .await;
            let decisions = fixture
                .commands()
                .iter()
                .filter(|command| {
                    command["method"]
                        .as_str()
                        .unwrap()
                        .starts_with("Fetch.continue")
                        || command["method"] == "Fetch.failRequest"
                })
                .map(|command| {
                    (
                        command["method"].clone(),
                        command["params"]["requestId"].clone(),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(
                decisions,
                [
                    (json!("Fetch.continueRequest"), json!("navigation-1")),
                    (json!("Fetch.continueRequest"), json!("allowed")),
                    (json!("Fetch.continueRequest"), json!("script")),
                    (json!("Fetch.failRequest"), json!("foreign")),
                ]
            );
            assert_eq!(
                fixture.command("Fetch.failRequest")["params"]["errorReason"],
                "BlockedByClient"
            );
            assert_eq!(
                owner.safety.failure().as_deref(),
                Some("A disallowed navigation or external protocol was blocked")
            );
            assert!(owner.settled.borrow().is_none());
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn child_frame_documents_are_blocked_and_fatal() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([paused(
                    "session-main",
                    "child",
                    "https://example.test/",
                    "Document",
                    "frame-child"
                )]),
            )
            .await;
            settles(&owner).await;
            assert_eq!(
                fixture.command("Fetch.failRequest")["params"]["requestId"],
                "child"
            );
            assert_eq!(
                owner.safety.failure().as_deref(),
                Some("Child frames are unsupported")
            );
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn shutdown_disposes_the_context_before_closing_the_browser() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.shutdown().await.unwrap();
            let commands = fixture.commands();
            let tail = &commands[commands.len() - 2..];
            assert_eq!(tail[0]["method"], "Target.disposeBrowserContext");
            assert_eq!(tail[0]["params"], json!({"browserContextId": "ctx-1"}));
            assert_eq!(tail[1]["method"], "Browser.close");
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn dispose_and_close_share_one_bounded_race() {
        bounded(async {
            let fixture = Fixture::with(
                "normal",
                json!({"silent": ["Target.disposeBrowserContext", "Browser.close"]}),
            );
            let mut options = fixture.options();
            options.command_timeout = Duration::from_secs(30);
            options.close_timeout = Duration::from_secs(1);
            let owner = Owned::launch(options).await.unwrap();
            let started = std::time::Instant::now();
            tokio::time::timeout(Duration::from_secs(6), owner.shutdown())
                .await
                .unwrap()
                .unwrap();
            assert!(started.elapsed() < Duration::from_secs(4));
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn a_browser_that_exits_after_close_is_not_signaled() {
        bounded(async {
            let fixture = Fixture::with("normal", json!({"linger": 0.15, "term_marker": true}));
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.shutdown().await.unwrap();
            assert!(!fixture.root.join("terminated").exists());
            fixture.assert_cleanup();
        })
        .await;
    }
    fn ax(role: &str, name: &str, backend: i64) -> Value {
        json!({"role": {"value": role}, "name": {"value": name}, "backendDOMNodeId": backend})
    }
    fn page_behavior() -> Value {
        json!({
            "title": "Home",
            "ax": [
                ax("button", "Go", 10),
                ax("link", "Docs", 11),
                ax("textbox", "Secret", 12),
                ax("textbox", "Name", 13),
                ax("heading", "Title", 14),
                {"role": {"value": "button"}, "name": {"value": "Hidden"}, "backendDOMNodeId": 15, "ignored": true},
                {"role": {"value": "button"}, "name": {"value": "Off"}, "backendDOMNodeId": 16,
                 "description": {"value": "turned off"},
                 "properties": [{"name": "disabled", "value": {"value": true}}]},
            ],
            "dom": {
                "10": {"nodeName": "BUTTON", "attributes": []},
                "11": {"nodeName": "A", "attributes": ["href", "/docs/guide?x=1#y"]},
                "12": {"nodeName": "INPUT", "attributes": ["type", "password"]},
                "13": {"nodeName": "INPUT", "attributes": ["type", "text"]},
                "16": {"nodeName": "BUTTON", "attributes": []},
                "20": {"nodeName": "A", "attributes": ["download", "", "href", "/f"]},
                "21": {"nodeName": "A", "attributes": ["target", "_blank"]},
                "22": {"nodeName": "A", "attributes": ["href", "https://evil.test/x"]},
            },
        })
    }
    async fn run_action(
        owner: &Owned,
        action: Value,
        origins: &[&str],
    ) -> Result<super::super::isolated::ActionOutput, super::ExecutorError> {
        let (_cancel, signal) = tokio::sync::watch::channel(false);
        owner
            .page()
            .act(
                decode(action),
                origins.iter().map(|origin| origin.to_string()).collect(),
                signal,
            )
            .await
    }
    fn text(value: &ycoding_schema::LosslessString) -> &str {
        value.as_str().unwrap()
    }
    #[tokio::test]
    async fn a_page_that_never_commits_fails_the_launch_and_is_reaped() {
        bounded(async {
            let fixture = Fixture::with("normal", json!({"stuck_navigation": true}));
            let mut options = fixture.options();
            options.startup_timeout = Duration::from_secs(1);
            assert!(Owned::launch(options).await.is_err());
            assert!(!fixture.methods().contains(&"Fetch.continueRequest".into()));
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn observation_lists_bounded_interactive_elements_and_advances_the_revision() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let first = owner.page().observe().await.unwrap();
            assert_eq!(text(&first.title), "Home");
            assert_eq!(text(&first.url), "https://example.test/");
            assert_eq!(
                (
                    first.document_generation.get(),
                    first.revision.get(),
                    first.truncated
                ),
                (1, 1, false)
            );
            let listed = first
                .elements
                .iter()
                .map(|element| {
                    (
                        text(&element.r#ref),
                        text(&element.role),
                        text(&element.name),
                    )
                })
                .collect::<Vec<_>>();
            assert_eq!(
                listed,
                [
                    ("b1", "button", "Go"),
                    ("b2", "link", "Docs"),
                    ("b4", "textbox", "Name"),
                    ("b5", "button", "Off"),
                ]
            );
            let destination = first.elements[1].destination.as_ref().unwrap();
            assert_eq!(
                (text(&destination.origin), text(&destination.path)),
                ("https://example.test", "/docs/guide")
            );
            assert_eq!(first.elements[3].disabled, Some(true));
            assert_eq!(
                first.elements[3].description.as_ref().map(text),
                Some("turned off")
            );
            assert_eq!(owner.page().observe().await.unwrap().revision.get(), 2);
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn observation_truncates_at_the_element_limit() {
        bounded(async {
            let nodes = (0..201)
                .map(|index| ax("button", "n", 100 + index))
                .collect::<Vec<_>>();
            let fixture = Fixture::with("normal", json!({"ax": nodes}));
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let snapshot = owner.page().observe().await.unwrap();
            assert_eq!((snapshot.elements.len(), snapshot.truncated), (200, true));
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn a_main_frame_navigation_advances_the_document_generation_and_drops_references() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            assert_eq!(owner.page().document().generation, 1);
            emit(
                &owner,
                json!([{"method": "Page.frameNavigated", "sessionId": "session-main",
                        "params": {"frame": {"id": "frame-child", "url": "https://example.test/x"}}}]),
            )
            .await;
            emit(
                &owner,
                json!([{"method": "Page.frameNavigated", "sessionId": "session-main",
                        "params": {"frame": {"id": "frame-main", "url": "https://example.test/next"}}}]),
            )
            .await;
            eventually(|| owner.page().document().generation == 2).await;
            assert!(owner.page().document().refs.is_empty());
            let failure = run_action(&owner, json!({"type": "click", "ref": "b1"}), &["https://example.test"])
                .await
                .unwrap_err();
            assert_eq!(failure.message, "Semantic element reference is stale");
            let after = owner.page().observe().await.unwrap();
            assert_eq!((after.document_generation.get(), after.revision.get()), (2, 1));
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn a_destroyed_controllable_target_is_fatal() {
        bounded(async {
            let fixture = Fixture::new("normal");
            let owner = Owned::launch(fixture.options()).await.unwrap();
            emit(
                &owner,
                json!([{"method": "Target.targetDestroyed", "params": {"targetId": "target-main"}}]),
            )
            .await;
            settles(&owner).await;
            assert_eq!(
                owner.safety.failure().as_deref(),
                Some("The controllable browser target was destroyed")
            );
            owner.shutdown().await.unwrap();
            fixture.assert_cleanup();
        })
        .await;
    }
    #[tokio::test]
    async fn pause_blocks_observation_and_actions_and_resume_refuses_after_a_safety_failure() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().pause();
            let paused = owner.page().observe().await.unwrap_err();
            assert_eq!(
                (paused.message.as_str(), paused.phase),
                ("Isolated browser control is paused", super::super::isolated::Phase::Predispatch)
            );
            assert_eq!(
                run_action(&owner, json!({"type": "scroll", "deltaY": 5}), &["https://example.test"])
                    .await
                    .unwrap_err()
                    .message,
                "Isolated browser control is paused"
            );
            owner.page().resume().unwrap();
            assert_eq!(owner.page().observe().await.unwrap().revision.get(), 1);
            emit(
                &owner,
                json!([{"method": "Page.fileChooserOpened", "sessionId": "session-main", "params": {}}]),
            )
            .await;
            eventually(|| owner.page().safety.paused()).await;
            assert_eq!(
                owner.page().resume().unwrap_err().message,
                "File selection is unsupported"
            );
            assert_eq!(
                owner.page().observe().await.unwrap_err().message,
                "File selection is unsupported"
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn navigate_actions_update_the_allowed_origins_and_deny_their_clipboard_first() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let origins = ["https://example.test", "https://other.test"];
            let refused = run_action(
                &owner,
                json!({"type": "navigate", "url": "https://third.test/"}),
                &origins,
            )
            .await
            .unwrap_err();
            assert_eq!(
                (refused.message.as_str(), refused.phase),
                (
                    "Navigation origin is not approved",
                    super::super::isolated::Phase::Predispatch
                )
            );
            assert_eq!(
                fixture
                    .methods()
                    .iter()
                    .filter(|method| *method == "Page.navigate")
                    .count(),
                1
            );
            let output = run_action(
                &owner,
                json!({"type": "navigate", "url": "https://other.test/page"}),
                &origins,
            )
            .await
            .unwrap();
            assert_eq!(text(&output.snapshot.url), "https://other.test/page");
            assert_eq!(
                (
                    output.snapshot.document_generation.get(),
                    output.snapshot.revision.get()
                ),
                (2, 0)
            );
            assert!(output.rejected.is_none() && output.capture.is_none());
            let commands = fixture.commands();
            let second = commands
                .iter()
                .rposition(|command| command["method"] == "Page.navigate")
                .unwrap();
            let denied = commands[..second]
                .iter()
                .filter(|command| command["method"] == "Browser.setPermission")
                .count();
            assert_eq!(denied, 2 + 2 * 2 * 2);
            assert_eq!(
                commands[second]["params"],
                json!({"url": "https://other.test/page"})
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn click_scrolls_resolves_the_center_and_presses_then_releases() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let output = run_action(
                &owner,
                json!({"type": "click", "ref": "b1"}),
                &["https://example.test"],
            )
            .await
            .unwrap();
            assert_eq!(text(&output.snapshot.url), "https://example.test/");
            let commands = fixture.commands();
            let tail = commands
                .iter()
                .skip_while(|command| command["method"] != "DOM.scrollIntoViewIfNeeded")
                .take(4)
                .collect::<Vec<_>>();
            assert_eq!(
                tail.iter()
                    .map(|command| command["method"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                [
                    "DOM.scrollIntoViewIfNeeded",
                    "DOM.getContentQuads",
                    "Input.dispatchMouseEvent",
                    "Input.dispatchMouseEvent"
                ]
            );
            assert_eq!(tail[0]["params"], json!({"backendNodeId": 10}));
            for (event, kind) in tail[2..].iter().zip(["mousePressed", "mouseReleased"]) {
                assert_eq!(
                    event["params"],
                    json!({"type": kind, "x": 5.0, "y": 5.0, "button": "left", "clickCount": 1})
                );
            }
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn unsafe_clicks_are_refused_before_any_input_is_dispatched() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            for (backend, message) in [
                (20, "Downloads are unsupported"),
                (21, "New tabs and popups are unsupported"),
                (22, "Link destination is not approved"),
                (12, "Protected inputs are unsupported"),
            ] {
                owner.page().document().refs.insert("b9".into(), backend);
                let failure = run_action(
                    &owner,
                    json!({"type": "click", "ref": "b9"}),
                    &["https://example.test"],
                )
                .await
                .unwrap_err();
                assert_eq!(
                    (failure.message.as_str(), failure.phase),
                    (message, super::super::isolated::Phase::Predispatch),
                    "{backend}"
                );
            }
            assert!(
                !fixture
                    .methods()
                    .contains(&"Input.dispatchMouseEvent".into())
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn invisible_elements_are_not_clicked() {
        bounded(async {
            let mut behavior = page_behavior();
            behavior["quads"] = json!([]);
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let failure = run_action(
                &owner,
                json!({"type": "click", "ref": "b1"}),
                &["https://example.test"],
            )
            .await
            .unwrap_err();
            assert_eq!(failure.message, "Element is not visible");
            assert!(
                !fixture
                    .methods()
                    .contains(&"Input.dispatchMouseEvent".into())
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn type_focuses_the_element_then_inserts_text_and_refuses_protected_inputs() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            run_action(
                &owner,
                json!({"type": "type", "ref": "b4", "text": "hello"}),
                &["https://example.test"],
            )
            .await
            .unwrap();
            let commands = fixture.commands();
            let focus = commands
                .iter()
                .position(|command| command["method"] == "DOM.focus")
                .unwrap();
            assert_eq!(commands[focus]["params"], json!({"backendNodeId": 13}));
            assert_eq!(commands[focus + 1]["method"], "Input.insertText");
            assert_eq!(commands[focus + 1]["params"], json!({"text": "hello"}));
            owner.page().document().refs.insert("b9".into(), 12);
            let failure = run_action(
                &owner,
                json!({"type": "type", "ref": "b9", "text": "x"}),
                &["https://example.test"],
            )
            .await
            .unwrap_err();
            assert_eq!(failure.message, "Protected inputs are unsupported");
            assert_eq!(
                fixture
                    .methods()
                    .iter()
                    .filter(|method| *method == "Input.insertText")
                    .count(),
                1
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn scroll_dispatches_a_wheel_event_and_capture_returns_a_checked_screenshot() {
        bounded(async {
            let fixture = Fixture::with("normal", page_behavior());
            let owner = Owned::launch(fixture.options()).await.unwrap();
            run_action(
                &owner,
                json!({"type": "scroll", "deltaY": 120}),
                &["https://example.test"],
            )
            .await
            .unwrap();
            assert_eq!(
                fixture.command("Input.dispatchMouseEvent")["params"],
                json!({"type": "mouseWheel", "x": 0, "y": 0, "deltaX": 0, "deltaY": 120})
            );
            let output = run_action(
                &owner,
                json!({"type": "capture"}),
                &["https://example.test"],
            )
            .await
            .unwrap();
            let capture = output.capture.unwrap();
            assert_eq!(text(&capture.data), "iVBORw0KGgo=");
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn capture_is_refused_while_a_password_field_is_present() {
        bounded(async {
            let fixture = Fixture::with(
                "normal",
                json!({"document": {"nodeName": "#document", "children": [
                    {"nodeName": "INPUT", "attributes": ["type", "password"]}]}}),
            );
            let owner = Owned::launch(fixture.options()).await.unwrap();
            let failure = run_action(
                &owner,
                json!({"type": "capture"}),
                &["https://example.test"],
            )
            .await
            .unwrap_err();
            assert_eq!(
                failure.message,
                "Capture is disabled while password fields are present"
            );
            assert!(!fixture.methods().contains(&"Page.captureScreenshot".into()));
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn popups_are_reported_as_rejected_and_downloads_fail_the_action() {
        bounded(async {
            let popup = attached("popup-session", "popup-target", "page", "target-main", true);
            let mut behavior = page_behavior();
            behavior["on_click"] = json!([popup]);
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let output = run_action(
                &owner,
                json!({"type": "click", "ref": "b1"}),
                &["https://example.test"],
            )
            .await
            .unwrap();
            assert_eq!(
                output.rejected.as_ref().map(text),
                Some("A popup was safely blocked")
            );
            assert_eq!(owner.safety.popups(), 1);
            assert_eq!(
                fixture.command("Target.closeTarget")["params"]["targetId"],
                "popup-target"
            );
            owner.shutdown().await.unwrap();

            let mut behavior = page_behavior();
            behavior["on_click"] = json!([{"method": "Browser.downloadWillBegin", "params": {}}]);
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let failure = run_action(
                &owner,
                json!({"type": "click", "ref": "b1"}),
                &["https://example.test"],
            )
            .await
            .unwrap_err();
            assert_eq!(
                (failure.message.as_str(), failure.phase),
                (
                    "A download attempt was blocked",
                    super::super::isolated::Phase::Postdispatch
                )
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    #[tokio::test]
    async fn leaving_the_approved_origin_fails_the_observation_after_dispatch() {
        bounded(async {
            let mut behavior = page_behavior();
            behavior["click_url"] = json!("https://evil.test/landed");
            let fixture = Fixture::with("normal", behavior);
            let owner = Owned::launch(fixture.options()).await.unwrap();
            owner.page().observe().await.unwrap();
            let failure = run_action(
                &owner,
                json!({"type": "click", "ref": "b1"}),
                &["https://example.test"],
            )
            .await
            .unwrap_err();
            assert_eq!(
                (failure.message.as_str(), failure.phase),
                (
                    "The browser crossed its approved origin boundary",
                    super::super::isolated::Phase::Postdispatch
                )
            );
            owner.shutdown().await.unwrap();
        })
        .await;
    }
    fn decode<T: ycoding_schema::DomainDecode>(value: Value) -> T {
        T::decode(&ycoding_schema::parse_json(&value.to_string()).unwrap()).unwrap()
    }
    fn service(fixture: &Fixture) -> std::sync::Arc<super::super::isolated::Service> {
        super::super::isolated::Service::new(
            std::sync::Arc::new(super::super::chrome_executor::IsolatedChrome::with(
                fixture.options(),
            )),
            std::sync::Arc::new(super::super::admission::Admission::default()),
            std::sync::Arc::new(|_| true),
            super::super::isolated::Options::default(),
        )
    }
    fn session() -> ycoding_schema::session_id::SessionId {
        decode(json!("ses_lifecycle"))
    }
    #[tokio::test]
    async fn service_shutdown_joins_ready_or_canceled_startup_process_and_profile() {
        bounded(async {
            for mode in ["ignore-term", "hang"] {
                let fixture = Fixture::new(mode);
                let session = session();
                let service = service(&fixture);
                let worker = service.clone();
                let task_session = session.clone();
                let start = tokio::spawn(async move {
                    worker
                        .start(
                            &task_session,
                            decode(json!({"url":"https://example.test/"})),
                        )
                        .await
                });
                eventually(|| fixture.methods().contains(&"Browser.getVersion".into())).await;
                if mode == "ignore-term" {
                    assert_eq!(
                        start.await.unwrap().unwrap().state,
                        ycoding_schema::isolated_browser::State::Ready
                    );
                    service.shutdown().await.unwrap();
                } else {
                    service.shutdown().await.unwrap();
                    let _ = start.await.unwrap();
                }
                fixture.assert_cleanup();
                assert!(service.list(&session).is_err());
            }
        })
        .await;
    }
    #[tokio::test]
    async fn the_isolated_service_drives_a_launched_page_through_observe_act_pause_and_stop() {
        bounded(async {
            let mut behavior = page_behavior();
            behavior["click_url"] = json!("https://example.test/clicked");
            let fixture = Fixture::with("normal", behavior);
            let session = session();
            let service = service(&fixture);
            let status = service
                .start(&session, decode(json!({"url":"https://example.test/"})))
                .await
                .unwrap();
            assert_eq!(status.state, ycoding_schema::isolated_browser::State::Ready);
            let tab = status.tab.clone().unwrap();
            assert_eq!(text(&tab.page.origin), "https://example.test");
            let instance = status.instance_id.clone().unwrap();
            let observation = service
                .observe(ycoding_schema::isolated_browser::ObserveInput {
                    session_id: session.clone(),
                    instance_id: instance.clone(),
                    tab_id: tab.id.clone(),
                    generation: tab.generation,
                    call_id: decode(json!("call_observe")),
                })
                .await
                .unwrap();
            assert_eq!(observation.elements.len(), 4);
            let result = service
                .action(ycoding_schema::isolated_browser::ActionInput {
                    session_id: session.clone(),
                    instance_id: instance,
                    tab_id: tab.id.clone(),
                    generation: tab.generation,
                    document_generation: observation.document_generation,
                    observation_revision: observation.revision,
                    call_id: decode(json!("call_click")),
                    action: decode(json!({"type": "click", "ref": "b1"})),
                })
                .await
                .unwrap();
            assert_eq!(
                result.status,
                ycoding_schema::isolated_browser::ActionStatus::Completed
            );
            assert_eq!(text(&result.tab.page.path), "/clicked");
            service.stop(&session).await.unwrap();
            fixture.assert_cleanup();
            assert!(!fixture.methods().is_empty());
        })
        .await;
    }
}
