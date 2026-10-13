#![cfg(unix)]

#[path = "support/launcher.rs"]
mod launcher;
mod support;

use launcher::{Directory, Runtime, read, string};
use prost::Message;
use std::{
    io::BufRead,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use ycoding_core::meeting::{
    discovery,
    store::{MeetingDatabase, from_store},
};
use ycoding_core::ycoding_schema::parse_json;
use ycoding_core::ycoding_store::{Options, Store, import};
use ycoding_protocol::v5;

struct Fixture {
    directory: Directory,
    project: PathBuf,
    stable: PathBuf,
    beta: PathBuf,
    writer: Option<Child>,
}

impl Fixture {
    fn new() -> Self {
        let directory = Directory::new();
        let project = directory.0.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let stable = discovery::directory(
            &project,
            Some(&directory.0.join("data")),
            &directory.0.join("home"),
        )
        .unwrap();
        let beta = directory
            .0
            .join("data/ycoding-beta/meeting")
            .join(stable.file_name().unwrap());
        Self {
            directory,
            project,
            stable,
            beta,
            writer: None,
        }
    }

    fn source(&self) -> PathBuf {
        self.stable.join("meetings.sqlite")
    }
    fn file(&self) -> PathBuf {
        self.beta.join("meetings.redb")
    }
    fn marker(&self) -> PathBuf {
        self.beta.join("stable-import-v1.json")
    }

    fn generate(&mut self, wal: bool) {
        let mut command = Command::new("bun");
        command
            .args(["run", "test/fixture/stable-meeting.ts"])
            .arg(self.source())
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../extensions/meeting"));
        if !wal {
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let mut child = command
            .arg("wal")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        self.writer = Some(child);
    }

    fn stable_files(&self) -> Vec<Option<Vec<u8>>> {
        [
            "meetings.sqlite",
            "meetings.sqlite-wal",
            "meetings.sqlite-shm",
        ]
        .map(|name| std::fs::read(self.stable.join(name)).ok())
        .to_vec()
    }

    async fn start(&self) -> Runtime {
        let catalog = self.directory.0.join("models.json");
        std::fs::write(&catalog, "{}").unwrap();
        let mut command = self.directory.command("meeting-import-test", "beta");
        command
            .env("YCODING_MODELS_PATH", catalog)
            .env_remove("CURSOR_API_KEY")
            .env_remove("YCODING_PRINT_LOGS");
        let runtime = Runtime::spawn(command, &["--service", "--port", "0", "--meeting"]);
        runtime.ready();
        let registration = read(&self.directory.registration("beta"));
        let address = string(&registration, "url")
            .strip_prefix("http://")
            .unwrap()
            .parse()
            .unwrap();
        let mut wire = support::Client::open(
            address,
            &[(
                "authorization",
                support::basic(&string(&registration, "password")),
            )],
        )
        .await
        .unwrap();
        let _: v5::AgentListResult = support::success(
            wire.call(
                "agent.list",
                support::wire::location_scope(self.project.to_str().unwrap()),
                v5::AgentListRequest {
                    query: support::wire::query(self.project.to_str().unwrap(), None),
                }
                .encode_to_vec(),
            )
            .await,
        );
        runtime
    }

    async fn history(&self) {
        let control = discovery::Control::connect(&self.beta).unwrap();
        let status = control
            .send(
                &from_store(&parse_json(r#"{"action":"select","meetingID":"imported"}"#).unwrap())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status["meeting"]["id"], "imported");
        assert_eq!(status["segments"][0]["rawText"], "  สวัสดี stable  ");
        assert_eq!(status["segments"][0]["text"], "สวัสดี stable");
        assert_eq!(status["findings"][0]["summary"], "Preserve stable history");
        assert_eq!(status["summary"]["summary"], "Imported summary");
        assert_eq!(status["plan"]["content"], "Imported plan");
        assert_eq!(status["proposals"][0]["id"], "proposal");
    }

    fn report(&self) -> import::Report {
        let store = Store::open(
            self.file(),
            Options::meeting(),
            import::catalog(import::DatabaseKind::Meeting),
        )
        .unwrap();
        let snapshot = store.snapshot().unwrap();
        let report = snapshot
            .get::<import::ProvenanceTable>(&[])
            .unwrap()
            .unwrap();
        drop(snapshot);
        store.shutdown().unwrap();
        report
    }

    fn no_partial_import(&self) {
        assert!(!self.file().exists());
        assert!(!self.marker().exists());
        assert!(!self.beta.join("bridge.json").exists());
        assert!(!self.beta.join("runtime.lock").exists());
        assert!(
            !std::fs::read_dir(self.directory.0.join("tmp/ycoding-beta"))
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("stable-import-"))
        );
    }

    fn finish(&self, mut runtime: Runtime) -> String {
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
        std::fs::read_to_string(self.directory.0.join("data/ycoding-beta/log/ycoding.log")).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(writer) = &mut self.writer {
            drop(writer.stdin.take());
            assert!(writer.wait().unwrap().success());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn beta_first_start_imports_the_ts_meeting_store_and_serves_retained_history() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for wal in [false, true] {
            let mut fixture = Fixture::new();
            fixture.generate(wal);
            let before = fixture.stable_files();
            if wal {
                assert!(before[1].as_ref().is_some_and(|bytes| !bytes.is_empty()));
            }
            let runtime = fixture.start().await;
            assert!(
                fixture.file().exists(),
                "the beta Meeting service must import before opening its own store"
            );
            fixture.history().await;
            fixture.finish(runtime);
            assert_eq!(fixture.stable_files(), before);
            assert!(!fixture.stable.join("meetings.redb").exists());
            assert!(!fixture.stable.join("bridge.json").exists());
            assert!(!fixture.stable.join("runtime.lock").exists());
            let report = fixture.report();
            assert_eq!(report.importer_version, 1);
            assert_eq!(report.tables.len(), 9);
            assert!(report.tables.iter().all(|table| table.rows == 1));
            assert_eq!(
                std::fs::read_to_string(fixture.marker()).unwrap(),
                "{\"complete\":true,\"version\":1,\"imported\":true}\n"
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(fixture.marker())
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
                assert_eq!(
                    std::fs::metadata(fixture.file())
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
            }
        }
    })
    .await
    .expect("beta Meeting import exceeded 60 seconds");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn absent_source_is_decided_once_and_does_not_import_later_stable_history() {
    let mut fixture = Fixture::new();
    fixture.finish(fixture.start().await);
    assert_eq!(
        std::fs::read_to_string(fixture.marker()).unwrap(),
        "{\"complete\":true,\"version\":1,\"imported\":false}\n"
    );
    fixture.generate(false);
    let before = fixture.stable_files();
    let runtime = fixture.start().await;
    let control = discovery::Control::connect(&fixture.beta).unwrap();
    let view = control
        .send(&from_store(&parse_json(r#"{"action":"status"}"#).unwrap()).unwrap())
        .await
        .unwrap();
    assert_eq!(view["meetings"].as_array().unwrap().len(), 0);
    fixture.finish(runtime);
    assert_eq!(fixture.stable_files(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn imported_history_and_beta_writes_survive_restart_and_missing_marker_recovery() {
    let mut fixture = Fixture::new();
    fixture.generate(false);
    let before = fixture.stable_files();
    fixture.finish(fixture.start().await);
    let report = fixture.report();
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    database
        .create_meeting("beta-only", "Beta history", "ses_beta_only")
        .await
        .unwrap();
    database.close().await.unwrap();
    for marker_missing in [false, true] {
        if marker_missing {
            std::fs::remove_file(fixture.marker()).unwrap();
        }
        let runtime = fixture.start().await;
        fixture.history().await;
        fixture.finish(runtime);
        let database = MeetingDatabase::open(&fixture.file()).unwrap();
        assert_eq!(
            database.get_meeting("beta-only").unwrap().unwrap()["title"],
            "Beta history"
        );
        database.close().await.unwrap();
        assert_eq!(fixture.report(), report);
        assert_eq!(fixture.stable_files(), before);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn corrupt_source_leaves_no_partial_store_logs_a_location_failure_and_can_retry() {
    let mut fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.stable).unwrap();
    std::fs::write(fixture.source(), b"not SQLite").unwrap();
    let before = fixture.stable_files();
    let diagnostics = fixture.finish(fixture.start().await);
    assert!(diagnostics.contains("Stable Meeting history import failed"));
    fixture.no_partial_import();
    assert_eq!(fixture.stable_files(), before);
    std::fs::remove_file(fixture.source()).unwrap();
    fixture.generate(false);
    let before = fixture.stable_files();
    let runtime = fixture.start().await;
    fixture.history().await;
    fixture.finish(runtime);
    assert_eq!(fixture.stable_files(), before);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_completion_or_missing_imported_store_is_not_replaced() {
    for marker in [
        "{}",
        "{\"complete\":true,\"version\":1,\"imported\":true}\n",
    ] {
        let mut fixture = Fixture::new();
        fixture.generate(false);
        let before = fixture.stable_files();
        std::fs::create_dir_all(&fixture.beta).unwrap();
        std::fs::write(fixture.marker(), marker).unwrap();
        let diagnostics = fixture.finish(fixture.start().await);
        assert!(diagnostics.contains("invalid beta import marker or missing imported store"));
        assert!(!fixture.file().exists());
        assert!(!fixture.beta.join("bridge.json").exists());
        assert_eq!(std::fs::read_to_string(fixture.marker()).unwrap(), marker);
        assert_eq!(fixture.stable_files(), before);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_existing_unmarked_store_without_provenance_is_never_overwritten() {
    let mut fixture = Fixture::new();
    fixture.generate(false);
    let before = fixture.stable_files();
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    database
        .create_meeting("native", "Unmarked native store", "ses_native")
        .await
        .unwrap();
    database.close().await.unwrap();
    let diagnostics = fixture.finish(fixture.start().await);
    assert!(diagnostics.contains("beta store has no completed import provenance"));
    assert!(!fixture.beta.join("bridge.json").exists());
    assert!(!fixture.marker().exists());
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    assert_eq!(
        database.get_meeting("native").unwrap().unwrap()["title"],
        "Unmarked native store"
    );
    assert!(database.get_meeting("imported").unwrap().is_none());
    database.close().await.unwrap();
    assert_eq!(fixture.stable_files(), before);
}
