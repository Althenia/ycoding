pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{fs, path::Path};
use ycoding_core::platform::git::{IndexPolicy, Repository, Service, UntrackedPolicy};
use ycoding_schema::file_diff::Status;

fn git(cwd: &Path, args: &[&str]) -> String {
    filesystem_fixture::git(cwd, args)
}

#[test]
fn discovers_metadata_without_a_work_tree_and_ignores_nonrepositories() {
    let fixture = Fixture::new();
    let service = Service::new(16 * 1024 * 1024);
    assert!(service.discover(&fixture.0).unwrap().is_none());
    fixture.repository();
    fixture.git(&["config", "core.bare", "true"]);
    let found = service.discover(&fixture.0).unwrap().unwrap();
    assert_eq!(found.worktree, fixture.0);
    assert_eq!(found.git_directory, fixture.0.join(".git"));
    assert_eq!(found.common_directory, found.git_directory);
}

fn remote(fixture: &Fixture) -> (std::path::PathBuf, String) {
    fixture.git(&["init", "--bare", "origin.git"]);
    fs::create_dir(fixture.0.join("source")).unwrap();
    let source = fixture.0.join("source");
    git(&source, &["init", "-b", "main"]);
    git(&source, &["config", "user.name", "Test"]);
    git(&source, &["config", "user.email", "test@ycoding.test"]);
    git(&source, &["config", "commit.gpgsign", "false"]);
    fs::write(source.join("README.md"), "one\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "initial"]);
    let origin = url::Url::from_file_path(fixture.0.join("origin.git"))
        .unwrap()
        .to_string();
    git(&source, &["remote", "add", "origin", &origin]);
    git(&source, &["push", "-u", "origin", "main"]);
    fixture.git(&[
        "--git-dir",
        "origin.git",
        "symbolic-ref",
        "HEAD",
        "refs/heads/main",
    ]);
    (source, origin)
}

#[test]
fn clones_fetches_checks_out_and_resets_remote_changes() {
    let fixture = Fixture::new();
    let (source, origin) = remote(&fixture);
    let service = Service::new(16 * 1024 * 1024);
    let target = fixture.0.join("checkout");
    let repository = service
        .clone_repository(&origin, &target, None, None)
        .unwrap();
    assert_eq!(repository.worktree, target);
    assert_eq!(repository.git_directory, target.join(".git"));
    assert_eq!(repository.common_directory, repository.git_directory);
    assert_eq!(
        service.remote(&repository, "origin").unwrap().as_deref(),
        Some(origin.as_str())
    );
    assert!(service.head(&repository).unwrap().is_some());
    assert_eq!(
        service.branch(&repository).unwrap().as_deref(),
        Some("main")
    );
    assert_eq!(
        service
            .default_remote_branch(&repository, "origin")
            .unwrap()
            .as_deref(),
        Some("main")
    );
    assert_eq!(service.root_commits(&repository).unwrap().len(), 1);
    fs::write(source.join("README.md"), "two\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "second"]);
    git(&source, &["push"]);
    service.fetch_remotes(&repository, true).unwrap();
    service.reset_hard(&repository, "origin/main").unwrap();
    assert_eq!(
        fs::read_to_string(target.join("README.md")).unwrap(),
        "two\n"
    );
    git(&source, &["checkout", "-b", "feature/docs"]);
    fs::write(source.join("README.md"), "feature\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "feature"]);
    git(&source, &["push", "-u", "origin", "feature/docs"]);
    service
        .fetch_branch(&repository, "origin", "feature/docs", true)
        .unwrap();
    service
        .checkout_remote_branch(&repository, "origin", "feature/docs", true)
        .unwrap();
    service
        .reset_hard(&repository, "origin/feature/docs")
        .unwrap();
    assert_eq!(
        service.branch(&repository).unwrap().as_deref(),
        Some("feature/docs")
    );
    assert_eq!(
        fs::read_to_string(target.join("README.md")).unwrap(),
        "feature\n"
    );
}

#[test]
fn scoped_trees_capture_compare_preview_and_restore_without_other_scope_changes() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.write("scope/tracked.txt", "one\n");
    fixture.write("outside.txt", "outside\n");
    fixture.git(&["add", "."]);
    fixture.git(&["commit", "-m", "initial"]);
    let service = Service::new(16 * 1024 * 1024);
    let source = service.discover(&fixture.0).unwrap().unwrap();
    let repository = service
        .create_repository(&fixture.0, &fixture.0.join(".snapshot"), Some(&source))
        .unwrap();
    service
        .refresh_index(&repository, "scope", None, None)
        .unwrap();
    let before = service.write_tree(&repository).unwrap();
    fixture.write("scope/tracked.txt", "two\n");
    fixture.write("scope/added.txt", "added\n");
    fixture.write("outside.txt", "changed outside\n");
    let after = service
        .capture_tree(&repository, &["scope"], None, None)
        .unwrap();
    assert_eq!(
        service.tree_files(&repository, &before, &after).unwrap(),
        ["scope/added.txt", "scope/tracked.txt"]
    );
    let diffs = service
        .tree_diff(&repository, &before, &after, 1, None)
        .unwrap();
    assert_eq!(
        diffs
            .iter()
            .map(|d| (d.file.to_utf8().unwrap(), d.status))
            .collect::<Vec<_>>(),
        [
            ("scope/added.txt".into(), Status::Added),
            ("scope/tracked.txt".into(), Status::Modified)
        ]
    );
    assert_eq!(
        service
            .read_tree(&repository, &before, "scope/tracked.txt")
            .unwrap()
            .unwrap(),
        b"one\n"
    );
    let files = [("scope/tracked.txt".to_string(), before)];
    let preview = service.preview(&repository, &after, &files, 1).unwrap();
    assert_eq!(preview.len(), 1);
    assert_eq!(preview[0].file.to_utf8().unwrap(), "scope/tracked.txt");
    assert!(
        fs::read_dir(&repository.git_directory)
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("preview-"))
    );
    service.restore(&repository, &files).unwrap();
    assert_eq!(
        fs::read_to_string(fixture.0.join("scope/tracked.txt")).unwrap(),
        "one\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("scope/added.txt")).unwrap(),
        "added\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("outside.txt")).unwrap(),
        "changed outside\n"
    );
}

#[test]
fn captures_and_applies_binary_and_untracked_changes_with_discard_policies() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.write("tracked", "before\n");
    fixture.write("binary", [0, 1, 2]);
    fixture.git(&["add", "."]);
    fixture.git(&["commit", "-m", "files"]);
    fixture.write("tracked", "after\n");
    fixture.write("binary", [0, 3, 4]);
    fixture.write("new file", "new\n");
    let service = Service::new(16 * 1024 * 1024);
    let repository = service.discover(&fixture.0).unwrap().unwrap();
    let changes = service.capture_changes(&repository, &fixture.0).unwrap();
    service
        .discard(
            &repository,
            &fixture.0,
            IndexPolicy::Reset,
            UntrackedPolicy::Remove,
        )
        .unwrap();
    assert_eq!(fs::read(fixture.0.join("binary")).unwrap(), [0, 1, 2]);
    assert!(!fixture.0.join("new file").exists());
    service
        .apply_changes(&repository, &fixture.0, &changes)
        .unwrap();
    assert_eq!(fs::read(fixture.0.join("binary")).unwrap(), [0, 3, 4]);
    assert_eq!(
        fs::read_to_string(fixture.0.join("tracked")).unwrap(),
        "after\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("new file")).unwrap(),
        "new\n"
    );
    service
        .discard(
            &repository,
            &fixture.0,
            IndexPolicy::Preserve,
            UntrackedPolicy::Preserve,
        )
        .unwrap();
    assert!(fixture.0.join("new file").exists());
}

#[test]
fn ignore_rules_and_maximum_untracked_bytes_do_not_stage_excluded_files() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.write(".gitignore", "scope/ignored\n");
    fixture.git(&["add", ".gitignore"]);
    fixture.git(&["commit", "-m", "ignore"]);
    fixture.write("scope/ignored", "ignore");
    fixture.write("scope/large", "12345");
    fixture.write("scope/small", "1234");
    let service = Service::new(16 * 1024 * 1024);
    let source = service.discover(&fixture.0).unwrap().unwrap();
    let repository = service
        .create_repository(&fixture.0, &fixture.0.join(".snapshot"), Some(&source))
        .unwrap();
    assert_eq!(
        service
            .ignored(&source, &["scope/ignored", "scope/small"])
            .unwrap(),
        ["scope/ignored"]
    );
    assert_eq!(
        service
            .refresh_index(&repository, "scope", Some(&source), Some(4))
            .unwrap(),
        ["scope/large"]
    );
    let tree = service.write_tree(&repository).unwrap();
    assert!(
        service
            .read_tree(&repository, &tree, "scope/ignored")
            .unwrap()
            .is_none()
    );
    assert!(
        service
            .read_tree(&repository, &tree, "scope/large")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        service
            .read_tree(&repository, &tree, "scope/small")
            .unwrap()
            .unwrap(),
        b"1234"
    );
}

#[test]
fn subprocess_output_limit_is_explicit_and_never_returns_truncated_success() {
    let fixture = Fixture::new();
    fixture.repository();
    let service = Service::new(1);
    assert!(service.discover(&fixture.0).is_err());
    let repository = Repository {
        worktree: fixture.0.clone(),
        git_directory: fixture.0.join(".git"),
        common_directory: fixture.0.join(".git"),
    };
    assert!(service.head(&repository).is_err());
}
