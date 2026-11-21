#[path = "support/launcher.rs"]
pub mod launcher;
mod support;

use launcher::{Directory, Runtime, string};
use prost::Message;
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use ycoding_protocol::v5;

fn packaged_command(directory: &Directory) -> Command {
    let mut command = Command::new(
        std::env::var_os("YCODING_TEST_PACKAGED_CLI").expect("fresh packaged CLI required"),
    );
    command.env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        command.env("PATH", path);
    }
    let environment = directory.command("unused", "local");
    for (key, value) in environment.get_envs() {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
    command.current_dir(&directory.0);
    command
}

fn extracted(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        if entry.file_type().unwrap().is_dir() {
            found.extend(extracted(&entry.path()));
        } else if entry.file_name() == "ycoding-runtime" {
            found.push(entry.path());
        }
    }
    found
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires YCODING_TEST_PACKAGED_CLI and YCODING_TEST_RELEASE_RUNTIME from a fresh native build"]
async fn embedded_native_payload_is_exact_authenticated_and_corruption_is_refused() {
    let directory = Directory::new();
    let mut command = packaged_command(&directory);
    command.env("YCODING_PASSWORD", "packaged-synthetic-password");
    let mut runtime = Runtime::spawn(command, &["serve", "--stdio", "--port", "0"]);
    let ready = ycoding_core::ycoding_schema::parse_json(&runtime.ready()).unwrap();
    let url = string(&ready, "url");
    let address = url.strip_prefix("http://").unwrap().parse().unwrap();
    let mut client = support::Client::open(
        address,
        &[(
            "Authorization",
            "Basic eWNvZGluZzpwYWNrYWdlZC1zeW50aGV0aWMtcGFzc3dvcmQ=".into(),
        )],
    )
    .await
    .unwrap();
    let health: v5::HealthGetResult = support::success(
        client
            .call(
                "health.get",
                v5::Scope {
                    target: Some(v5::scope::Target::Machine(v5::Empty {})),
                },
                v5::HealthGetRequest {}.encode_to_vec(),
            )
            .await,
    );
    assert!(health.data.healthy);
    let payloads = extracted(&directory.0);
    assert_eq!(payloads.len(), 1);
    assert_eq!(
        std::fs::read(&payloads[0]).unwrap(),
        std::fs::read(std::env::var_os("YCODING_TEST_RELEASE_RUNTIME").unwrap()).unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&payloads[0])
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    drop(client);
    drop(runtime.child.stdin.take());
    assert!(runtime.wait().success());
    std::fs::write(&payloads[0], b"corrupt private test payload").unwrap();
    let output = packaged_command(&directory)
        .args(["serve", "--stdio", "--port", "0"])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        )
        .contains("does not match the embedded payload"),
        "stderr={}; stdout={}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(
        std::fs::read(&payloads[0]).unwrap(),
        b"corrupt private test payload"
    );
}
