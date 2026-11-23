#![cfg(unix)]
mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use remote_derived_support::Fixture;
use std::{path::Path, process::Stdio, time::Duration};
use support::start;
use tokio::process::Command;
use ycoding_runtime::standard;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_tui_admits_png_and_text_and_retains_native_rejection() {
    let fixture = Fixture::new().await;
    let mut services = fixture.environment(true).services.clone();
    services.core.as_mut().unwrap().roots = Some(fixture.platform.config.roots().clone());
    let server = start(services, standard().unwrap()).await;
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let script = root.join("packages/tui/test-integration/native-attachment.tsx");
    let png = root.join("rust/crates/core/src/resources/image/small.png");
    let child = Command::new("bun")
        .arg("run")
        .arg(script)
        .arg(format!("http://{}", server.address()))
        .arg(&fixture.directory)
        .arg(&fixture.root)
        .arg(png)
        .current_dir(root.join("packages/tui"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(90), child.wait_with_output())
        .await
        .expect("TUI acceptance exceeded 90 seconds")
        .unwrap();
    server.shutdown().await.unwrap();
    fixture.close().await;
    assert!(
        output.status.success(),
        "TUI acceptance failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
