mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{fs, process::Command};
use ycoding_core::platform::git::{Service, vcs};
use ycoding_schema::file_diff::Status;

#[test]
fn git_unborn_binary_deletion_and_subdirectory_scope() {
    let fixture = Fixture::new();
    fixture.git(&["init", "-b", "main"]);
    fixture.write("nested/new.txt", "new\n");
    fixture.write("outside.txt", "outside\n");
    let git = Service::new(16 * 1024 * 1024);
    let unborn = vcs::diff(&git, &fixture.0.join("nested"), false, None);
    assert_eq!(unborn.len(), 1);
    assert_eq!(unborn[0].file.as_str(), Some("nested/new.txt"));
    assert_eq!(unborn[0].additions.get(), 1);
    assert!(unborn[0].patch.as_str().unwrap().contains("+new"));
    fixture.git(&["config", "user.name", "Test"]);
    fixture.git(&["config", "user.email", "test@ycoding.test"]);
    fixture.git(&["config", "commit.gpgsign", "false"]);
    fixture.git(&["add", "."]);
    fixture.git(&["commit", "-m", "base"]);
    fs::remove_file(fixture.0.join("nested/new.txt")).unwrap();
    fixture.write("nested/binary.dat", [0, 1, 2]);
    let status = vcs::status(&git, &fixture.0.join("nested"));
    assert_eq!(status.len(), 2);
    let binary = status
        .iter()
        .find(|file| file.file.ends_with("binary.dat"))
        .unwrap();
    assert_eq!(
        (binary.additions, binary.deletions, binary.status),
        (0, 0, Status::Added)
    );
    let deleted = status
        .iter()
        .find(|file| file.file.ends_with("new.txt"))
        .unwrap();
    assert_eq!(
        (deleted.additions, deleted.deletions, deleted.status),
        (0, 1, Status::Deleted)
    );
}

#[test]
fn git_default_remote_selection_and_branch_short_circuit() {
    let fixture = Fixture::new();
    fixture.repository();
    let git = Service::new(16 * 1024 * 1024);
    fixture.git(&["branch", "stable"]);
    fixture.git(&["remote", "add", "origin", "https://example.invalid/repo"]);
    fixture.git(&["update-ref", "refs/remotes/origin/stable", "HEAD"]);
    fixture.git(&[
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/stable",
    ]);
    assert_eq!(
        vcs::branch(&git, &fixture.0).default.as_deref(),
        Some("stable")
    );
    fixture.git(&["checkout", "stable"]);
    fixture.write("new.txt", "new\n");
    assert!(vcs::diff(&git, &fixture.0, true, None).is_empty());
}

#[test]
fn git_capped_batch_retains_complete_prefix_and_synthesizes_empty_trailing_patch() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.write("a.txt", "old\n");
    fixture.write("b.txt", "old\n");
    fixture.git(&["add", "."]);
    fixture.git(&["commit", "-m", "base"]);
    fixture.write("a.txt", "new\n");
    fixture.write("b.txt", "x\n".repeat(4_000_000));
    fixture.write("c.txt", "extra\n");
    let git = Service::new(16 * 1024 * 1024);
    let diff = vcs::diff(&git, &fixture.0, false, None);
    assert_eq!(diff.len(), 3);
    assert!(diff[0].patch.as_str().unwrap().contains("+new"));
    assert_eq!(
        diff[1].patch.as_str().unwrap(),
        "Index: b.txt\n===================================================================\n--- b.txt\t\n+++ b.txt\t\n"
    );
    assert_eq!(diff[1].additions.get(), 4_000_000);
    assert!(diff[2].patch.as_str().unwrap().contains("+extra"));
}

fn hg(fixture: &Fixture, args: &[&str]) -> String {
    let output = Command::new("hg")
        .args(args)
        .env("HGPLAIN", "1")
        .env("HGRCPATH", "")
        .current_dir(&fixture.0)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().into()
}

#[test]
#[ignore = "requires hg on PATH"]
fn mercurial_branch_status_missing_untracked_context_and_named_branch() {
    let fixture = Fixture::new();
    hg(&fixture, &["init"]);
    fixture.write("one.txt", "one\ntwo\nthree\n");
    fixture.write("gone.txt", "bye\n");
    hg(&fixture, &["add"]);
    hg(
        &fixture,
        &["commit", "-u", "Test <test@ycoding.test>", "-m", "base"],
    );
    let git = Service::new(16 * 1024 * 1024);
    let branch = vcs::branch(&git, &fixture.0);
    assert_eq!(branch.current.as_deref(), Some("default"));
    assert_eq!(branch.default.as_deref(), Some("default"));
    fixture.write("one.txt", "one\nchanged\nthree\n");
    fs::remove_file(fixture.0.join("gone.txt")).unwrap();
    fixture.write("new.txt", "hello\n");
    let diff = vcs::diff(&git, &fixture.0, false, Some(0));
    assert_eq!(diff.len(), 3);
    let missing = diff
        .iter()
        .find(|file| file.file.as_str() == Some("gone.txt"))
        .unwrap();
    assert_eq!(missing.status, Status::Deleted);
    assert!(missing.patch.as_str().unwrap().contains("-bye"));
    let new = diff
        .iter()
        .find(|file| file.file.as_str() == Some("new.txt"))
        .unwrap();
    assert_eq!(new.additions.get(), 1);
    assert!(new.patch.as_str().unwrap().contains("+hello"));
    let modified = diff
        .iter()
        .find(|file| file.file.as_str() == Some("one.txt"))
        .unwrap();
    assert_eq!((modified.additions.get(), modified.deletions.get()), (1, 1));
    assert!(!modified.patch.as_str().unwrap().contains(" one\n"));
    assert!(vcs::diff(&git, &fixture.0, true, None).is_empty());
    hg(&fixture, &["branch", "feature"]);
    hg(&fixture, &["addremove"]);
    hg(
        &fixture,
        &["commit", "-u", "Test <test@ycoding.test>", "-m", "feature"],
    );
    assert_eq!(vcs::diff(&git, &fixture.0, true, None).len(), 3);
}

#[test]
#[ignore = "requires hg on PATH"]
fn mercurial_unborn_and_subdirectory_scope() {
    let fixture = Fixture::new();
    hg(&fixture, &["init"]);
    fixture.write("nested/a.txt", "a\n");
    fixture.write("outside.txt", "outside\n");
    hg(&fixture, &["add", "nested/a.txt"]);
    let git = Service::new(16 * 1024 * 1024);
    let diff = vcs::diff(&git, &fixture.0.join("nested"), false, None);
    assert_eq!(diff.len(), 1);
    assert_eq!(diff[0].file.as_str(), Some("nested/a.txt"));
    assert_eq!(diff[0].additions.get(), 1);
}
