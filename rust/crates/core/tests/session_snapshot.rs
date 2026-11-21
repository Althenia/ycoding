use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use ycoding_core::{
    platform::git::Service as Git,
    session::{
        revert::{self, Snapshots},
        snapshot::{GitSnapshots, snapshot_directory},
        store::Service,
    },
};
use ycoding_schema::{
    file_diff::Status, parse_json, schema::RelativePath, session, session_message,
};
use ycoding_store::session::{Message, MessageTable};

#[path = "session_support/mod.rs"]
mod support;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self::under(Path::new(env!("CARGO_TARGET_TMPDIR")))
    }

    fn outside_any_repository() -> Self {
        Self::under(&std::env::temp_dir())
    }

    fn under(parent: &Path) -> Self {
        let root = parent.join(format!(
            "snapshot-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }

    fn write(&self, name: &str, content: &str) {
        let path = self.0.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.0.join(name)).unwrap()
    }

    fn project(&self) -> PathBuf {
        self.0.join("project")
    }

    fn data(&self) -> PathBuf {
        self.0.join("data")
    }

    fn snapshots(&self, directory: &Path, enabled: bool) -> GitSnapshots {
        GitSnapshots::new(
            Arc::new(Git::new(16 * 1024 * 1024)),
            self.data(),
            "prj_one".into(),
            directory.into(),
            directory.into(),
            enabled,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn git(directory: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "user.email=test@ycoding.test",
        ])
        .args(["-c", "user.name=Test", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn relative(value: &str) -> RelativePath {
    RelativePath::new(value).unwrap()
}

#[test]
fn captures_a_location_scope_then_diffs_and_restores_only_selected_paths() {
    let fixture = Fixture::new();
    fixture.write("project/scope/tracked.txt", "one\n");
    fixture.write("project/outside.txt", "outside\n");
    git(&fixture.project(), &["init"]);
    git(&fixture.project(), &["add", "."]);
    let snapshots = fixture.snapshots(&fixture.project().join("scope"), true);

    let before = snapshots.capture().unwrap();
    fixture.write("project/scope/tracked.txt", "two\n");
    fixture.write("project/scope/added.txt", "added\n");
    fixture.write("project/outside.txt", "changed outside\n");
    let after = snapshots.capture().unwrap();

    assert_eq!(
        snapshots.files(&before, &after).unwrap(),
        vec![relative("scope/added.txt"), relative("scope/tracked.txt")]
    );

    let diffs = snapshots
        .diff(
            &before,
            &after,
            &[relative("scope/added.txt"), relative("scope/tracked.txt")],
        )
        .unwrap();
    assert_eq!(
        diffs
            .iter()
            .map(|diff| (diff.file.to_utf8().unwrap(), diff.status))
            .collect::<Vec<_>>(),
        [
            ("scope/added.txt".to_string(), Status::Added),
            ("scope/tracked.txt".to_string(), Status::Modified),
        ]
    );
    let unchanged = snapshots
        .diff(&before, &after, &[relative("outside.txt")])
        .unwrap();
    assert_eq!(unchanged.len(), 1);
    assert_eq!(unchanged[0].additions.get(), 0);
    assert_eq!(unchanged[0].deletions.get(), 0);
    assert_eq!(unchanged[0].status, Status::Modified);
    assert!(snapshots.diff(&before, &after, &[]).unwrap().is_empty());

    snapshots
        .restore(&[(relative("scope/tracked.txt"), before)])
        .unwrap();
    assert_eq!(fixture.read("project/scope/tracked.txt"), "one\n");
    assert_eq!(fixture.read("project/scope/added.txt"), "added\n");
    assert_eq!(fixture.read("project/outside.txt"), "changed outside\n");
}

#[test]
fn restoring_a_path_absent_from_its_tree_removes_the_file() {
    let fixture = Fixture::new();
    fixture.write("project/tracked.txt", "one\n");
    git(&fixture.project(), &["init"]);
    let snapshots = fixture.snapshots(&fixture.project(), true);
    let before = snapshots.capture().unwrap();
    fixture.write("project/created.txt", "new\n");

    snapshots
        .restore(&[(relative("created.txt"), before)])
        .unwrap();

    assert!(!fixture.project().join("created.txt").exists());
    assert_eq!(fixture.read("project/tracked.txt"), "one\n");
}

#[test]
fn restore_rejects_paths_outside_the_project() {
    let fixture = Fixture::new();
    fixture.write("project/tracked.txt", "one\n");
    fixture.write("escape.txt", "keep\n");
    git(&fixture.project(), &["init"]);
    let snapshots = fixture.snapshots(&fixture.project(), true);
    let before = snapshots.capture().unwrap();

    let result = snapshots.restore(&[(relative("../escape.txt"), before)]);

    assert_eq!(result.unwrap_err().operation, "restore");
    assert_eq!(fixture.read("escape.txt"), "keep\n");
}

#[test]
fn capture_outside_git_is_unavailable_and_restore_reports_the_failure() {
    let outside = Fixture::outside_any_repository();
    outside.write("project/file.txt", "one\n");
    let snapshots = GitSnapshots::new(
        Arc::new(Git::new(16 * 1024 * 1024)),
        outside.data(),
        "prj_one".into(),
        outside.project(),
        outside.project(),
        true,
    );

    assert!(snapshots.capture().is_none());
    let failure = snapshots
        .restore(&[(
            relative("file.txt"),
            ycoding_schema::snapshot::Id::new("0".repeat(40)).unwrap(),
        )])
        .unwrap_err();
    assert_eq!(failure.message, "Project is not a Git repository");
}

#[test]
fn disabled_snapshots_capture_nothing_and_refuse_restore() {
    let fixture = Fixture::new();
    fixture.write("project/file.txt", "one\n");
    git(&fixture.project(), &["init"]);
    let snapshots = fixture.snapshots(&fixture.project(), false);

    assert!(snapshots.capture().is_none());
    let failure = snapshots.restore(&[]).unwrap_err();
    assert_eq!(failure.message, "Snapshots are disabled");
    assert!(!fixture.data().join("snapshot").exists());
}

#[test]
fn creates_the_snapshot_repository_lazily_per_canonical_worktree() {
    let fixture = Fixture::new();
    fixture.write("project/tracked.txt", "main\n");
    git(&fixture.project(), &["init"]);
    git(&fixture.project(), &["add", "."]);
    git(&fixture.project(), &["commit", "-m", "initial"]);
    let linked = fixture.0.join("linked");
    git(
        &fixture.project(),
        &["worktree", "add", "--detach", linked.to_str().unwrap()],
    );

    let project = fixture.snapshots(&fixture.project(), true);
    let other = fixture.snapshots(&linked, true);
    assert!(!fixture.data().join("snapshot").exists());

    assert!(project.capture().is_some());
    assert!(other.capture().is_some());
    for worktree in [fixture.project(), linked] {
        assert!(
            snapshot_directory(&fixture.data(), "prj_one", &worktree)
                .join("HEAD")
                .exists()
        );
    }
    assert_ne!(
        snapshot_directory(&fixture.data(), "prj_one", &fixture.project()),
        snapshot_directory(&fixture.data(), "prj_one", &fixture.0.join("linked"))
    );
}

#[test]
fn diff_omits_files_the_source_repository_ignores() {
    let fixture = Fixture::new();
    fixture.write("project/.gitignore", "*.log\n");
    fixture.write("project/build.log", "first\n");
    fixture.write("project/kept.txt", "first\n");
    git(&fixture.project(), &["init"]);
    git(&fixture.project(), &["add", "."]);
    git(&fixture.project(), &["add", "-f", "build.log"]);
    let snapshots = fixture.snapshots(&fixture.project(), true);
    let before = snapshots.capture().unwrap();
    fixture.write("project/build.log", "second\n");
    fixture.write("project/kept.txt", "second\n");
    let after = snapshots.capture().unwrap();

    let diffs = snapshots
        .diff(
            &before,
            &after,
            &[relative("build.log"), relative("kept.txt")],
        )
        .unwrap();

    assert_eq!(
        diffs
            .iter()
            .map(|diff| diff.file.to_utf8().unwrap())
            .collect::<Vec<_>>(),
        ["kept.txt"]
    );
}

fn assistant_after_boundary(session: &str, id: &str, seq: i64, start: &str, file: &str) -> Message {
    Message {
        id: id.into(),
        session_id: session.into(),
        type_: "assistant".into(),
        seq,
        time_created: 1,
        time_updated: 1,
        data: parse_json(&format!(
            r#"{{"time":{{"created":1}},"agent":"build","model":{{"providerID":"local","id":"test"}},"content":[],"snapshot":{{"start":"{start}","files":["{file}"]}}}}"#
        ))
        .unwrap(),
    }
}

#[tokio::test]
async fn revert_stage_and_clear_move_real_files_between_snapshots() {
    let fixture = Fixture::new();
    fixture.write("project/tracked.txt", "one\n");
    git(&fixture.project(), &["init"]);
    git(&fixture.project(), &["add", "."]);
    let snapshots = fixture.snapshots(&fixture.project(), true);
    let start = snapshots.capture().unwrap();
    fixture.write("project/tracked.txt", "two\n");

    let store = support::store();
    let service = Service::new(store.client());
    let start_text = start.as_lossless().to_utf8().unwrap();
    store
        .submit(move |tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: "msg_boundary".into(),
                    session_id: "ses_one".into(),
                    type_: "user".into(),
                    seq: 1,
                    time_created: 1,
                    time_updated: 1,
                    data: parse_json(r#"{"text":"boundary","time":{"created":1}}"#).unwrap(),
                },
            )?;
            MessageTable::insert(
                tx,
                &assistant_after_boundary("ses_one", "msg_work", 2, &start_text, "tracked.txt"),
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let session = session::Id::new("ses_one").unwrap();

    let staged = revert::stage(
        &service,
        &snapshots,
        &service.get(&session).unwrap().unwrap(),
        &session_message::Id::new("msg_boundary").unwrap(),
        true,
        50,
    )
    .await
    .unwrap();

    assert_eq!(fixture.read("project/tracked.txt"), "one\n");
    let files = staged.files.unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].file.to_utf8().unwrap(), "tracked.txt");
    assert_eq!(files[0].status, Status::Modified);
    assert!(files[0].patch.to_utf8().unwrap().contains("-two"));

    revert::clear(
        &service,
        &snapshots,
        &service.get(&session).unwrap().unwrap(),
        60,
    )
    .await
    .unwrap();

    assert_eq!(fixture.read("project/tracked.txt"), "two\n");
    assert!(service.get(&session).unwrap().unwrap().revert.is_none());
}
