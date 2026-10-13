mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{fs, path::Path, process::Command};
use ycoding_core::platform::{
    git::Service,
    project_identity::{GLOBAL, Vcs, VcsKind, remote_id, resolve},
};

const TS_REMOTE_VECTORS: &[(&str, Option<&str>)] = &[
    (
        "https://github.com/Org/Repo.git",
        Some("88393ed3be8ea56041170f72be0d33ee21c2cffa"),
    ),
    (
        "https://GitHub.com/org/repo/",
        Some("c3376c3f028ea1c1fca8a8467223d0a0a3a1ba05"),
    ),
    (
        "git@github.com:org/repo.git",
        Some("c3376c3f028ea1c1fca8a8467223d0a0a3a1ba05"),
    ),
    (
        "ssh://git@github.com:2222/org/repo.git",
        Some("c3376c3f028ea1c1fca8a8467223d0a0a3a1ba05"),
    ),
    (
        "git@github.com:/org/repo.git/",
        Some("c3376c3f028ea1c1fca8a8467223d0a0a3a1ba05"),
    ),
    (
        "https://user:pass@example.com/a/b//",
        Some("040ceb89ec73905500f1df19cfe83b6a592d796a"),
    ),
    ("github.com:org/repo", None),
    ("https://example.com", None),
    (
        "ssh://[::1]/repo.git",
        Some("61685ae1e74cc708ec38c1f52590bfe7d8b505f2"),
    ),
    (
        "HTTPS://Example.COM/%7Euser/Repo.GIT",
        Some("a08a6f1cbab5ba5b2c57abc4690c370a89e7f9d3"),
    ),
    (
        "user@host:path with space",
        Some("c1e2fe091aa9c774dd593a9b0445f5d5d5629138"),
    ),
    (
        "https://bücher.example/repo",
        Some("40f37e98912296c15bc4cab26f9377e17d6783fa"),
    ),
    (
        "@host:repo",
        Some("9fa26f2fcc48dba4ee43a8a8c8871a023a69e2a8"),
    ),
    (
        "user@:repo",
        Some("a1cc424289d050c398dcd37e73373f54429740c6"),
    ),
    (
        "a@b@c:x/y.git",
        Some("51e0a7912f28dccbdfb2ce240288456334b4dd90"),
    ),
    ("host:/", None),
    (
        "http://Host.Example:8080/Group/Sub/Repo.git/",
        Some("7c3cced897c3183e0c8d5e1c6f6b4f152dd7ec5e"),
    ),
    ("file:///tmp/repo.git", None),
];

fn git() -> Service {
    Service::new(16 * 1024 * 1024)
}

#[test]
fn remote_identity_matches_typescript_project_resolve_vectors() {
    for (origin, expected) in TS_REMOTE_VECTORS {
        assert_eq!(remote_id(origin).as_deref(), *expected, "{origin}");
    }
}

#[test]
fn non_repository_directories_resolve_to_the_global_project_at_the_filesystem_root() {
    let fixture = Fixture::new();
    let resolved = resolve(&git(), &fixture.0.join("missing/nested")).unwrap();
    assert_eq!(resolved.id, GLOBAL);
    assert_eq!(resolved.directory, Path::new("/"));
    assert_eq!((resolved.previous, resolved.vcs), (None, None));
}

#[test]
fn git_identity_prefers_origin_then_cached_id_then_root_commit() {
    let fixture = Fixture::new();
    fixture.git(&["init", "-b", "main"]);
    let unborn = resolve(&git(), &fixture.0).unwrap();
    assert_eq!(unborn.id, GLOBAL);
    assert_eq!(unborn.directory, fixture.0);
    let store = fixture.0.join(".git");
    assert_eq!(
        unborn.vcs,
        Some(Vcs {
            kind: VcsKind::Git,
            store: store.clone()
        })
    );
    fixture.git(&["config", "commit.gpgsign", "false"]);
    fixture.git(&["config", "user.name", "Test"]);
    fixture.git(&["config", "user.email", "test@ycoding.test"]);
    fixture.git(&["commit", "--allow-empty", "-m", "root"]);
    let root = fixture.git(&["rev-list", "--max-parents=0", "HEAD"]);
    fs::create_dir_all(fixture.0.join("nested/deeper")).unwrap();
    let rooted = resolve(&git(), &fixture.0.join("nested/deeper")).unwrap();
    assert_eq!(rooted.id, root);
    assert_eq!(rooted.directory, fixture.0);
    assert_eq!(rooted.previous, None);
    fs::write(store.join("ycoding"), " cached-identity \n").unwrap();
    let cached = resolve(&git(), &fixture.0).unwrap();
    assert_eq!(cached.id, "cached-identity");
    assert_eq!(cached.previous.as_deref(), Some("cached-identity"));
    fixture.git(&["remote", "add", "origin", "git@github.com:org/repo.git"]);
    let remote = resolve(&git(), &fixture.0).unwrap();
    assert_eq!(remote.id, "c3376c3f028ea1c1fca8a8467223d0a0a3a1ba05");
    assert_eq!(remote.previous.as_deref(), Some("cached-identity"));
    fixture.git(&["remote", "set-url", "origin", "file:///tmp/repo.git"]);
    assert_eq!(resolve(&git(), &fixture.0).unwrap().id, "cached-identity");
    fs::write(store.join("ycoding"), "  \n").unwrap();
    assert_eq!(resolve(&git(), &fixture.0).unwrap().id, root);
}

#[test]
fn linked_worktrees_share_the_repository_identity_with_their_own_directory() {
    let fixture = Fixture::new();
    fixture.repository();
    let copy = fixture.0.join("copies/one");
    fixture.git(&["worktree", "add", "-q", copy.to_str().unwrap()]);
    let main = resolve(&git(), &fixture.0).unwrap();
    let linked = resolve(&git(), &copy).unwrap();
    assert_eq!(linked.id, main.id);
    assert_eq!(linked.directory, fs::canonicalize(&copy).unwrap());
    assert_eq!(linked.vcs, main.vcs);
}

fn hg(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("hg")
        .args(args)
        .env("HGPLAIN", "1")
        .env("HGRCPATH", "")
        .current_dir(cwd)
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
fn mercurial_identity_uses_the_cached_id_then_the_first_root_changeset() {
    let fixture = Fixture::new();
    hg(&fixture.0, &["init"]);
    let store = fixture.0.join(".hg");
    let empty = resolve(&git(), &fixture.0).unwrap();
    assert_eq!(empty.id, GLOBAL);
    assert_eq!(
        empty.vcs,
        Some(Vcs {
            kind: VcsKind::Hg,
            store: store.clone()
        })
    );
    fixture.write("one.txt", "one\n");
    hg(&fixture.0, &["add"]);
    hg(
        &fixture.0,
        &["commit", "-u", "Test <test@ycoding.test>", "-m", "base"],
    );
    let root = hg(&fixture.0, &["log", "-r", "roots(all())", "-T", "{node}"]);
    fs::create_dir_all(fixture.0.join("nested")).unwrap();
    let resolved = resolve(&git(), &fixture.0.join("nested")).unwrap();
    assert_eq!(resolved.id, root);
    assert_eq!(resolved.directory, fixture.0);
    assert_eq!(resolved.previous, None);
    fs::write(store.join("ycoding"), "hg-cached\n").unwrap();
    let cached = resolve(&git(), &fixture.0).unwrap();
    assert_eq!(cached.id, "hg-cached");
    assert_eq!(cached.previous.as_deref(), Some("hg-cached"));
}
