#![cfg(unix)]

#[path = "support/launcher.rs"]
mod launcher;
#[path = "launcher/stable_sources.rs"]
mod stable_sources;
mod support;

use launcher::{Directory, Runtime, read, string};
use prost::Message;
use std::{path::PathBuf, time::Duration};
use ycoding_core::meeting::{
    discovery,
    store::{MeetingDatabase, from_store},
};
use ycoding_core::ycoding_schema::parse_json;
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
        stable_sources::meeting_source(&self.stable, wal);
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

    async fn served_meetings(&self) -> usize {
        let control = discovery::Control::connect(&self.beta).unwrap();
        let view = control
            .send(&from_store(&parse_json(r#"{"action":"status"}"#).unwrap()).unwrap())
            .await
            .unwrap();
        view["meetings"].as_array().unwrap().len()
    }

    fn no_import_files(&self) {
        assert!(!self.marker().exists());
        if let Ok(entries) = std::fs::read_dir(&self.beta) {
            for entry in entries {
                let name = entry.unwrap().file_name().to_string_lossy().into_owned();
                assert!(
                    !name.contains("stable-import")
                        && !name.ends_with(".stage-v2")
                        && !name.ends_with(".import-lock"),
                    "unexpected import file {name}"
                );
            }
        }
    }

    fn finish(&self, mut runtime: Runtime) -> String {
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
        std::fs::read_to_string(self.directory.0.join("data/ycoding-beta/log/ycoding.log")).unwrap()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn beta_first_start_opens_an_empty_native_store_and_ignores_the_ts_meeting_store() {
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
                "the beta Meeting service opens its native store"
            );
            assert_eq!(fixture.served_meetings().await, 0);
            fixture.finish(runtime);
            assert_eq!(fixture.stable_files(), before);
            assert!(!fixture.stable.join("meetings.redb").exists());
            assert!(!fixture.stable.join("bridge.json").exists());
            assert!(!fixture.stable.join("runtime.lock").exists());
            fixture.no_import_files();
            let database = MeetingDatabase::open(&fixture.file()).unwrap();
            assert!(database.get_meeting("imported").unwrap().is_none());
            assert!(database.list_meetings("", 100).unwrap().is_empty());
            database.close().await.unwrap();
        }
    })
    .await
    .expect("beta Meeting startup exceeded 60 seconds");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stable_source_created_after_first_start_is_never_imported() {
    let fixture = Fixture::new();
    fixture.finish(fixture.start().await);
    fixture.no_import_files();
    fixture.materialize(false);
    let before = fixture.stable_files();
    let runtime = fixture.start().await;
    assert_eq!(fixture.served_meetings().await, 0);
    fixture.finish(runtime);
    assert_eq!(fixture.stable_files(), before);
    fixture.no_import_files();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn beta_writes_survive_restart_and_stable_history_stays_unimported() {
    let fixture = Fixture::new();
    fixture.materialize(false);
    let before = fixture.stable_files();
    fixture.finish(fixture.start().await);
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    database
        .create_meeting("beta-only", "Beta history", "ses_beta_only")
        .await
        .unwrap();
    database.close().await.unwrap();
    let runtime = fixture.start().await;
    assert_eq!(fixture.served_meetings().await, 1);
    fixture.finish(runtime);
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    assert_eq!(
        database.get_meeting("beta-only").unwrap().unwrap()["title"],
        "Beta history"
    );
    assert!(database.get_meeting("imported").unwrap().is_none());
    database.close().await.unwrap();
    assert_eq!(fixture.stable_files(), before);
    fixture.no_import_files();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_stable_source_is_ignored() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.stable).unwrap();
    std::fs::write(fixture.source(), b"not SQLite").unwrap();
    let before = fixture.stable_files();
    let runtime = fixture.start().await;
    assert_eq!(fixture.served_meetings().await, 0);
    let diagnostics = fixture.finish(runtime);
    assert!(!diagnostics.contains("Stable Meeting history import failed"));
    assert!(fixture.file().exists());
    assert_eq!(fixture.stable_files(), before);
    fixture.no_import_files();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_existing_import_marker_is_ignored_and_left_unchanged() {
    for marker in [
        "{}",
        "{\"complete\":true,\"version\":1,\"imported\":true}\n",
    ] {
        let fixture = Fixture::new();
        fixture.materialize(false);
        let before = fixture.stable_files();
        std::fs::create_dir_all(&fixture.beta).unwrap();
        std::fs::write(fixture.marker(), marker).unwrap();
        let runtime = fixture.start().await;
        assert_eq!(fixture.served_meetings().await, 0);
        fixture.finish(runtime);
        assert!(fixture.file().exists());
        assert_eq!(std::fs::read_to_string(fixture.marker()).unwrap(), marker);
        assert_eq!(fixture.stable_files(), before);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_existing_unmarked_native_store_is_opened_without_importing() {
    let fixture = Fixture::new();
    fixture.materialize(false);
    let before = fixture.stable_files();
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    database
        .create_meeting("native", "Unmarked native store", "ses_native")
        .await
        .unwrap();
    database.close().await.unwrap();
    let runtime = fixture.start().await;
    assert_eq!(fixture.served_meetings().await, 1);
    fixture.finish(runtime);
    let database = MeetingDatabase::open(&fixture.file()).unwrap();
    assert_eq!(
        database.get_meeting("native").unwrap().unwrap()["title"],
        "Unmarked native store"
    );
    assert!(database.get_meeting("imported").unwrap().is_none());
    database.close().await.unwrap();
    assert_eq!(fixture.stable_files(), before);
    fixture.no_import_files();
}
