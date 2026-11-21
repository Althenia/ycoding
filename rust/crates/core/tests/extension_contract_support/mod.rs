use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use ycoding_core::extension::{
    Configuration, Error, Extension, FamilyGrant, Host, Launch, Options, ToolGrant, v5,
};

pub mod world;

pub const CHILD: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/extension_contract_support/child.py"
);
pub const SHARED_CHILD: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py");

pub fn options() -> Options {
    Options {
        startup: Duration::from_secs(2),
        execution: Duration::from_secs(3),
        cleanup: Duration::from_millis(300),
        shutdown: Duration::from_millis(300),
        write: Duration::from_millis(500),
    }
}

pub fn family(family: v5::CapabilityFamily, scopes: &[&str]) -> FamilyGrant {
    FamilyGrant {
        family,
        scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
        action: "extension.family".into(),
        resources: vec!["contract".into()],
    }
}

pub fn configuration(
    root: &Path,
    name: &str,
    spec: Value,
    families: Vec<FamilyGrant>,
) -> Configuration {
    let spec_path = root.join(format!("{name}.json"));
    std::fs::write(&spec_path, spec.to_string()).unwrap();
    Configuration {
        identity: format!("fixture-{name}"),
        executable: "/usr/bin/python3".into(),
        args: vec![
            CHILD.into(),
            root.join(format!("{name}.evidence"))
                .to_str()
                .unwrap()
                .into(),
            spec_path.to_str().unwrap().into(),
        ],
        directory: root.to_path_buf(),
        registration_order: 0,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families,
    }
}

pub fn delegate(
    root: &Path,
    name: &str,
    mode: &str,
    extra: &[&str],
    families: Vec<FamilyGrant>,
) -> Configuration {
    configuration(
        root,
        name,
        json!({"delegate": {"script": SHARED_CHILD, "mode": mode, "extra": extra}}),
        families,
    )
}

pub fn evidence(root: &Path, name: &str) -> String {
    std::fs::read_to_string(root.join(format!("{name}.evidence"))).unwrap_or_default()
}

pub fn child_pid(root: &Path, name: &str) -> u32 {
    std::fs::read_to_string(root.join(format!("{name}.evidence.pid")))
        .unwrap()
        .parse()
        .unwrap()
}

pub fn lane_logs() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.lane-logs")
}

// A child that fails within milliseconds of spawn leaves the negotiate error, elapsed time, the
// child's own exit/signal record and its stderr in the lane log directory.
pub fn save_start_failure(root: &Path, name: &str, error: Error, elapsed: Duration) {
    let directory = lane_logs();
    std::fs::create_dir_all(&directory).unwrap();
    let alive = std::fs::read_to_string(root.join(format!("{name}.evidence.pid")))
        .ok()
        .and_then(|pid| pid.parse::<u32>().ok())
        .map(|pid| ycoding_core::platform::process::is_alive(pid).unwrap_or(false));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    std::fs::write(
        directory.join(format!("extension-start-failure-{name}-{stamp}.log")),
        format!(
            "negotiate error: {error:?} ({error})\nelapsed since spawn: {elapsed:?}\nchild alive after failure: {alive:?}\n--- child evidence ---\n{}",
            evidence(root, name)
        ),
    )
    .unwrap();
}

pub async fn start(
    root: &Path,
    name: &str,
    configuration: Configuration,
    registry: &ycoding_core::tools::registry::Registry,
    policy: Arc<ycoding_core::tools::context::policy::LeafPolicy>,
    host: Host,
    options: Options,
) -> Extension {
    let begun = Instant::now();
    match Extension::start(
        configuration,
        options,
        registry,
        policy,
        &Launch::default(),
        host,
    )
    .await
    {
        Ok(extension) => extension,
        Err(error) => {
            save_start_failure(root, name, error, begun.elapsed());
            panic!("{name}: extension failed to start: {error:?}");
        }
    }
}

pub async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

pub async fn marker(root: &Path, name: &str) {
    let path = root.join(name);
    eventually(name, || path.exists()).await;
}

pub fn lines(path: &Path) -> usize {
    std::fs::read_to_string(path)
        .map(|content| content.lines().count())
        .unwrap_or(0)
}

pub fn alive(pid: u32) -> bool {
    ycoding_core::platform::process::is_alive(pid).unwrap()
}

pub async fn gone(what: &str, pids: &[u32]) {
    let pids = pids.to_vec();
    eventually(what, move || pids.iter().all(|pid| !alive(*pid))).await;
}

pub fn pids(root: &Path, name: &str) -> (u32, u32) {
    let pids: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join(format!("{name}.pids"))).unwrap())
            .unwrap();
    (
        pids["child"].as_u64().unwrap() as u32,
        pids["grandchild"].as_u64().unwrap() as u32,
    )
}

// Descendants that survive a stop would otherwise outlive the test run.
pub fn reap(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status();
}

pub struct Reaper(pub u32);
impl Drop for Reaper {
    fn drop(&mut self) {
        reap(self.0);
    }
}
