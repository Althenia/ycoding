#![cfg(unix)]

#[path = "support/launcher.rs"]
mod launcher;
mod support;

use launcher::{Directory, Runtime, read, string};
use prost::Message;
use std::{os::unix::fs::PermissionsExt, path::Path, process::Command, time::Duration};
use ycoding_core::meeting::discovery;
use ycoding_core::ycoding_schema::{JsonValue, stringify_json};
use ycoding_protocol::v5;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn packaged_runtime_serves_the_existing_meeting_clients_without_adjacent_assets() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let directory = Directory::new();
        let project = directory.0.join("project");
        let package = directory.0.join("package");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        let executable = package.join("ycoding-runtime");
        std::fs::copy(env!("CARGO_BIN_EXE_ycoding-runtime"), &executable).unwrap();
        let model_catalog = directory.0.join("models.json");
        std::fs::write(&model_catalog, "{}").unwrap();
        let worker = directory.0.join("protocol-worker.py");
        std::fs::write(&worker, WORKER).unwrap();
        std::fs::set_permissions(&worker, std::fs::Permissions::from_mode(0o700)).unwrap();
        let meeting = discovery::directory(
            &project,
            Some(&directory.0.join("data")),
            &directory.0.join("home"),
        )
        .unwrap();
        std::fs::create_dir_all(&meeting).unwrap();
        std::fs::write(
            meeting.join("settings.json"),
            format!(
                r#"{{"transcription":{{"pythonExecutable":{},"chunkSeconds":1,"overlapSeconds":0}},"analysis":{{"incremental":false}},"streaming":{{"vad":false}}}}"#,
                stringify_json(&JsonValue::String(worker.to_str().unwrap().into()))
            ),
        )
        .unwrap();
        let template = directory.command("meeting-test", "local");
        let mut command = Command::new(&executable);
        command
            .env_clear()
            .envs(
                template
                    .get_envs()
                    .filter_map(|(key, value)| value.map(|value| (key, value))),
            )
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("YCODING_MODELS_PATH", &model_catalog)
            .current_dir(&package);
        let mut runtime = Runtime::spawn(command, &["--service", "--port", "0", "--meeting"]);
        let ready = runtime.ready();
        let registration = read(&directory.registration("local"));
        let url = string(&registration, "url");
        assert_eq!(ready, format!("server listening on {url}"));
        let address = url.strip_prefix("http://").unwrap().parse().unwrap();
        let mut wire = support::Client::open(
            address,
            &[("authorization", support::basic(&string(&registration, "password")))],
        )
        .await
        .unwrap();
        let _: v5::AgentListResult = support::success(
            wire.call(
                "agent.list",
                support::wire::location_scope(project.to_str().unwrap()),
                v5::AgentListRequest {
                    query: support::wire::query(project.to_str().unwrap(), None),
                }
                .encode_to_vec(),
            )
            .await,
        );
        drop(wire);
        let output = tokio::process::Command::new("bun")
            .args([
                "test",
                "test/rust-bridge-client.integration.test.tsx",
                "--timeout",
                "30000",
            ])
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../extensions/meeting"))
            .env("YCODING_TEST_MEETING_DIRECTORY", &project)
            .env("XDG_DATA_HOME", directory.0.join("data"))
            .env("YCODING_CHANNEL", "local")
            .kill_on_drop(true)
            .output()
            .await
            .unwrap();
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
        assert!(!meeting.join("bridge.json").exists());
        assert!(!meeting.join("runtime.lock").exists());
        assert!(
            output.status.success(),
            "Meeting clients failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    })
    .await
    .expect("real-runtime Meeting integration exceeded 90 seconds");
}

const WORKER: &str = r#"#!/usr/bin/env python3
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    response = {"id": request["id"], "ok": True}
    if request["op"] == "initialize":
        response["metrics"] = {"device": "cpu"}
    if request["op"] == "health":
        response["healthy"] = True
    if request["op"] == "transcribe":
        chunk = request["chunk"]
        response["results"] = [{"startMs": chunk["startMs"], "endMs": chunk["startMs"] + 900, "text": "สวัสดี Rust bridge"}]
    print(json.dumps(response), flush=True)
"#;
