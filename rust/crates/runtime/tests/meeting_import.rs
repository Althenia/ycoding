#![cfg(unix)]

#[path = "support/launcher.rs"]
mod launcher;
mod support;

use launcher::{Directory, Runtime, read, string};
use prost::Message;
use std::{
    path::{Path, PathBuf},
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

    fn materialize(&self, wal: bool) {
        let baseline = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../extensions/meeting/test/fixture/stable-meeting")
            .join(if wal { "wal" } else { "checkpointed" });
        std::fs::create_dir_all(&self.stable).unwrap();
        for name in [
            "meetings.sqlite",
            "meetings.sqlite-wal",
            "meetings.sqlite-shm",
        ] {
            if wal || name == "meetings.sqlite" {
                std::fs::copy(baseline.join(name), self.stable.join(name)).unwrap();
            }
        }
        if !wal {
            assert!(std::process::Command::new("python3").args(["-c", "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('PRAGMA journal_mode=WAL');db.close()"])
                .arg(self.source()).status().unwrap().success());
        }
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
    }

    fn finish(&self, mut runtime: Runtime) -> String {
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
        std::fs::read_to_string(self.directory.0.join("data/ycoding-beta/log/ycoding.log")).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn beta_first_start_imports_the_ts_meeting_store_and_serves_retained_history() {
    tokio::time::timeout(Duration::from_secs(60), async {
        for wal in [false, true] {
            let fixture = Fixture::new();
            fixture.materialize(wal);
            let before = fixture.stable_files();
            if wal {
                assert!(before[1].as_ref().is_some_and(|bytes| !bytes.is_empty()));
                assert!(before[2].as_ref().is_some_and(|bytes| !bytes.is_empty()));
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
            let ycoding_core::ycoding_schema::JsonValue::Object(marker) = read(&fixture.marker())
            else {
                panic!("selection is not an object");
            };
            assert_eq!(
                marker.get(&"version".into()),
                Some(&ycoding_core::ycoding_schema::JsonValue::Number(2.0))
            );
            assert_eq!(
                marker.get(&"sealed".into()),
                Some(&ycoding_core::ycoding_schema::JsonValue::Bool(true))
            );
            assert_eq!(
                marker.get(&"imported".into()),
                Some(&ycoding_core::ycoding_schema::JsonValue::Bool(true))
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
    let fixture = Fixture::new();
    fixture.finish(fixture.start().await);
    let ycoding_core::ycoding_schema::JsonValue::Object(marker) = read(&fixture.marker()) else {
        panic!("selection is not an object");
    };
    assert_eq!(
        marker.get(&"sealed".into()),
        Some(&ycoding_core::ycoding_schema::JsonValue::Bool(true))
    );
    assert_eq!(
        marker.get(&"imported".into()),
        Some(&ycoding_core::ycoding_schema::JsonValue::Bool(false))
    );
    fixture.materialize(false);
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
    let fixture = Fixture::new();
    fixture.materialize(false);
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
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.stable).unwrap();
    std::fs::write(fixture.source(), b"not SQLite").unwrap();
    let before = fixture.stable_files();
    let diagnostics = fixture.finish(fixture.start().await);
    assert!(diagnostics.contains("Stable Meeting history import failed"));
    fixture.no_partial_import();
    assert_eq!(fixture.stable_files(), before);
    std::fs::remove_file(fixture.source()).unwrap();
    fixture.materialize(false);
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
        let fixture = Fixture::new();
        fixture.materialize(false);
        let before = fixture.stable_files();
        std::fs::create_dir_all(&fixture.beta).unwrap();
        std::fs::write(fixture.marker(), marker).unwrap();
        let diagnostics = fixture.finish(fixture.start().await);
        assert!(
            diagnostics.contains(if marker.contains("version") {
                "unsupported v1 import marker"
            } else {
                "Invalid beta import selection"
            }),
            "{diagnostics}"
        );
        assert!(!fixture.file().exists());
        assert!(!fixture.beta.join("bridge.json").exists());
        assert_eq!(std::fs::read_to_string(fixture.marker()).unwrap(), marker);
        assert_eq!(fixture.stable_files(), before);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_existing_unmarked_store_without_provenance_is_never_overwritten() {
    let fixture = Fixture::new();
    fixture.materialize(false);
    let before = fixture.stable_files();
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    database
        .create_meeting("native", "Unmarked native store", "ses_native")
        .await
        .unwrap();
    database.close().await.unwrap();
    let diagnostics = fixture.finish(fixture.start().await);
    assert!(
        diagnostics.contains("Invalid beta import selection"),
        "{diagnostics}"
    );
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
