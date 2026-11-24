#![cfg(unix)]

#[path = "support/launcher_service.rs"]
mod launcher;
#[path = "launcher/stable_sources.rs"]
mod stable_sources;
mod support;

use launcher::{Directory, Runtime, read, string};
use prost::Message;
use stable_sources::{meeting_source, source_fixture};
use std::{
    collections::BTreeMap,
    ops::Bound,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Duration,
};
use ycoding_core::meeting::{
    discovery,
    store::{MeetingDatabase, from_store},
};
use ycoding_core::ycoding_schema::parse_json;
use ycoding_core::ycoding_store::{Options, Store, native, project::ProjectTable};
use ycoding_protocol::v5;
use ycoding_runtime::launch::sha1_hex;

const STABLE_ROOTS: [&str; 4] = [
    "config/ycoding",
    "state/ycoding",
    "data/ycoding",
    "cache/ycoding",
];
const MEETING_FAILURE: &str = "Stable Meeting history import failed";

#[derive(Debug, PartialEq)]
struct Entry {
    content: Option<String>,
    mode: u32,
    modified: (i64, i64),
}

struct Rehearsal {
    directory: Directory,
    project: PathBuf,
    meeting_stable: PathBuf,
    meeting_beta: PathBuf,
}

impl Rehearsal {
    fn new() -> Self {
        let directory = Directory::new();
        let project = directory.0.join("project");
        std::fs::create_dir_all(&project).unwrap();
        let meeting_stable = discovery::directory(
            &project,
            Some(&directory.0.join("data")),
            &directory.0.join("home"),
        )
        .unwrap();
        let meeting_beta = directory
            .0
            .join("data/ycoding-beta/meeting")
            .join(meeting_stable.file_name().unwrap());
        for (path, contents) in [
            ("config/ycoding/ycoding.json", "{}\n"),
            ("state/ycoding/kv.json", "{\"theme\":\"stable\"}\n"),
            ("cache/ycoding/version", "stable\n"),
        ] {
            let file = directory.0.join(path);
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, contents).unwrap();
        }
        Self {
            directory,
            project,
            meeting_stable,
            meeting_beta,
        }
    }

    fn stable_core(&self, project: &str) {
        let mut writer = source_fixture(
            &self.directory.0.join("data/ycoding/ycoding.db"),
            "plain",
            project,
            "",
        );
        drop(writer.stdin.take());
        assert!(writer.wait().unwrap().success());
    }

    fn stable_meeting(&self) {
        meeting_source(&self.meeting_stable, false);
    }

    fn corrupt_stable_meeting(&self) {
        std::fs::create_dir_all(&self.meeting_stable).unwrap();
        std::fs::write(self.meeting_stable.join("meetings.sqlite"), b"not SQLite").unwrap();
    }

    fn stable_snapshot(&self) -> BTreeMap<String, Entry> {
        let mut entries = BTreeMap::new();
        for root in STABLE_ROOTS {
            walk(
                &self.directory.0,
                &self.directory.0.join(root),
                &mut entries,
            );
        }
        entries
    }

    fn core_store(&self) -> PathBuf {
        self.directory.0.join("data/ycoding-beta/ycoding.redb")
    }

    fn core_marker(&self) -> PathBuf {
        self.directory
            .0
            .join("state/ycoding-beta/stable-import-v1.json")
    }

    fn meeting_store(&self) -> PathBuf {
        self.meeting_beta.join("meetings.redb")
    }

    fn meeting_marker(&self) -> PathBuf {
        self.meeting_beta.join("stable-import-v1.json")
    }

    fn command(&self) -> std::process::Command {
        let catalog = self.directory.0.join("models.json");
        std::fs::write(&catalog, "{}").unwrap();
        let mut command = self.directory.command("cutover-rehearsal", "beta");
        command.env("YCODING_MODELS_PATH", catalog);
        command
    }

    async fn start(&self) -> (Runtime, support::Client) {
        let runtime = Runtime::spawn(self.command(), &["--service", "--port", "0", "--meeting"]);
        runtime.ready();
        let registration = read(&self.directory.registration("beta"));
        let mut wire = support::Client::open(
            string(&registration, "url")
                .strip_prefix("http://")
                .unwrap()
                .parse()
                .unwrap(),
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
                support::wire::location_scope(self.directory_text()),
                v5::AgentListRequest {
                    query: support::wire::query(self.directory_text(), None),
                }
                .encode_to_vec(),
            )
            .await,
        );
        (runtime, wire)
    }

    fn stop(&self, mut runtime: Runtime, wire: support::Client) -> String {
        drop(wire);
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
        std::fs::read_to_string(self.directory.0.join("data/ycoding-beta/log/ycoding.log")).unwrap()
    }

    fn directory_text(&self) -> &str {
        self.project.to_str().unwrap()
    }

    async fn create_session(&self, wire: &mut support::Client) -> String {
        let created: v5::SessionCreateResult = support::success(
            wire.call(
                "session.create",
                support::wire::location_scope(self.directory_text()),
                v5::SessionCreateRequest {
                    payload: v5::SessionCreateRequestPayload {
                        id: None,
                        parent_id: None,
                        agent: None,
                        model: None,
                        location: Some(v5::LocationRef {
                            directory: support::text(self.directory_text()),
                            workspace_id: None,
                        }),
                        title: None,
                        scope: None,
                    },
                }
                .encode_to_vec(),
            )
            .await,
        );
        support::units(&created.data.id)
    }

    async fn session_title(&self, wire: &mut support::Client, id: &str) -> String {
        let fetched: v5::SessionGetResult = support::success(
            wire.call(
                "session.get",
                support::session_scope(id),
                v5::SessionGetRequest {
                    params: v5::SessionGetRequestParams {
                        session_id: support::text(id),
                    },
                }
                .encode_to_vec(),
            )
            .await,
        );
        assert_eq!(support::units(&fetched.data.id), id);
        support::units(&fetched.data.title)
    }

    async fn served_meetings(&self) -> usize {
        let control = discovery::Control::connect(&self.meeting_beta).unwrap();
        let view = control
            .send(&from_store(&parse_json(r#"{"action":"status"}"#).unwrap()).unwrap())
            .await
            .unwrap();
        view["meetings"].as_array().unwrap().len()
    }

    fn no_import_files(&self) {
        assert!(!self.core_marker().exists());
        assert!(!self.meeting_marker().exists());
    }

    fn core_projects(&self) -> Vec<String> {
        let store = Store::open(
            self.core_store(),
            Options::core(),
            native::catalog(native::DatabaseKind::Core),
        )
        .unwrap();
        let snapshot = store.snapshot().unwrap();
        let projects = snapshot
            .scan::<ProjectTable>(Bound::Unbounded, Bound::Unbounded, 100)
            .unwrap()
            .into_iter()
            .map(|project| project.id.as_str().unwrap().to_owned())
            .collect();
        drop(snapshot);
        store.shutdown().unwrap();
        projects
    }

    async fn write_beta_meeting(&self) {
        let database = MeetingDatabase::open(&self.meeting_store()).unwrap();
        database
            .create_meeting("beta-only", "Beta history", "ses_beta_only")
            .await
            .unwrap();
        database.close().await.unwrap();
    }

    async fn beta_meeting_title(&self) -> Option<String> {
        let database = MeetingDatabase::open(&self.meeting_store()).unwrap();
        let title = database
            .get_meeting("beta-only")
            .unwrap()
            .map(|meeting| meeting["title"].as_str().unwrap().to_owned());
        database.close().await.unwrap();
        title
    }
}

fn walk(base: &Path, path: &Path, entries: &mut BTreeMap<String, Entry>) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    let name = path
        .strip_prefix(base)
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let content = metadata
        .is_file()
        .then(|| sha1_hex(&std::fs::read(path).unwrap()));
    entries.insert(
        name,
        Entry {
            content,
            mode: metadata.mode(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
        },
    );
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).unwrap() {
            walk(base, &entry.unwrap().path(), entries);
        }
    }
}

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(120), future)
        .await
        .expect("cutover rehearsal exceeded its time bound")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daily_start_opens_native_beta_stores_and_later_starts_keep_beta_writes_unmerged() {
    bounded(async {
        let rehearsal = Rehearsal::new();
        rehearsal.stable_core("prj_stable");
        rehearsal.stable_meeting();
        let stable = rehearsal.stable_snapshot();

        let (runtime, mut wire) = rehearsal.start().await;
        let session = rehearsal.create_session(&mut wire).await;
        let title = rehearsal.session_title(&mut wire, &session).await;
        assert_eq!(rehearsal.served_meetings().await, 0);
        let log = rehearsal.stop(runtime, wire);
        assert!(!log.contains(MEETING_FAILURE), "{log}");
        assert_eq!(rehearsal.stable_snapshot(), stable);
        assert!(!rehearsal.core_projects().contains(&"prj_stable".to_owned()));
        rehearsal.no_import_files();
        rehearsal.write_beta_meeting().await;

        std::fs::remove_file(rehearsal.directory.0.join("data/ycoding/ycoding.db")).unwrap();
        rehearsal.stable_core("prj_after_cutover");
        rehearsal.corrupt_stable_meeting();
        let changed = rehearsal.stable_snapshot();

        let (runtime, mut wire) = rehearsal.start().await;
        assert_eq!(rehearsal.session_title(&mut wire, &session).await, title);
        assert_eq!(rehearsal.served_meetings().await, 1);
        let log = rehearsal.stop(runtime, wire);
        assert!(!log.contains(MEETING_FAILURE), "{log}");
        assert_eq!(
            rehearsal.beta_meeting_title().await.as_deref(),
            Some("Beta history")
        );
        let projects = rehearsal.core_projects();
        assert!(!projects.contains(&"prj_stable".to_owned()));
        assert!(!projects.contains(&"prj_after_cutover".to_owned()));
        rehearsal.no_import_files();
        assert_eq!(rehearsal.stable_snapshot(), changed);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_stable_meeting_source_does_not_affect_the_daily_start() {
    bounded(async {
        let rehearsal = Rehearsal::new();
        rehearsal.stable_core("prj_stable");
        rehearsal.corrupt_stable_meeting();
        let stable = rehearsal.stable_snapshot();

        let (runtime, mut wire) = rehearsal.start().await;
        let session = rehearsal.create_session(&mut wire).await;
        let title = rehearsal.session_title(&mut wire, &session).await;
        assert_eq!(rehearsal.served_meetings().await, 0);
        let log = rehearsal.stop(runtime, wire);
        assert!(!log.contains(MEETING_FAILURE), "{log}");
        assert!(
            !log.contains(rehearsal.meeting_stable.to_str().unwrap()),
            "{log}"
        );
        assert!(rehearsal.meeting_store().exists());
        rehearsal.no_import_files();
        assert_eq!(rehearsal.stable_snapshot(), stable);
        assert!(!rehearsal.core_projects().contains(&"prj_stable".to_owned()));

        std::fs::remove_file(rehearsal.meeting_stable.join("meetings.sqlite")).unwrap();
        rehearsal.stable_meeting();
        let repaired = rehearsal.stable_snapshot();
        let (runtime, mut wire) = rehearsal.start().await;
        assert_eq!(rehearsal.session_title(&mut wire, &session).await, title);
        assert_eq!(rehearsal.served_meetings().await, 0);
        let log = rehearsal.stop(runtime, wire);
        assert!(!log.contains(MEETING_FAILURE), "{log}");
        rehearsal.no_import_files();
        assert_eq!(rehearsal.stable_snapshot(), repaired);
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_corrupt_stable_core_source_does_not_stop_the_daily_start() {
    bounded(async {
        let rehearsal = Rehearsal::new();
        let source = rehearsal.directory.0.join("data/ycoding/ycoding.db");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"not SQLite").unwrap();
        rehearsal.stable_meeting();
        let stable = rehearsal.stable_snapshot();

        let (runtime, wire) = rehearsal.start().await;
        assert_eq!(rehearsal.served_meetings().await, 0);
        rehearsal.stop(runtime, wire);
        assert!(rehearsal.core_store().exists());
        assert!(rehearsal.meeting_store().exists());
        rehearsal.no_import_files();
        assert_eq!(rehearsal.stable_snapshot(), stable);

        std::fs::remove_file(&source).unwrap();
        rehearsal.stable_core("prj_stable");
        let repaired = rehearsal.stable_snapshot();
        let (runtime, wire) = rehearsal.start().await;
        assert_eq!(rehearsal.served_meetings().await, 0);
        rehearsal.stop(runtime, wire);
        assert!(!rehearsal.core_projects().contains(&"prj_stable".to_owned()));
        rehearsal.no_import_files();
        assert_eq!(rehearsal.stable_snapshot(), repaired);
    })
    .await;
}
