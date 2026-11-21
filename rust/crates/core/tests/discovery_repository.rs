use std::{
    fs,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
use ycoding_core::resources::discovery::repository::{self, Error};
static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn repository_spellings_cache_identity_and_github_clone_override_match_typescript() {
    let shorthand = repository::parse_remote(" owner/repo.git/ ", None).unwrap();
    assert_eq!(shorthand.host, "github.com");
    assert_eq!(shorthand.path, "owner/repo");
    assert_eq!(shorthand.owner.as_deref(), Some("owner"));
    assert_eq!(shorthand.remote, "https://github.com/owner/repo.git");
    assert_eq!(shorthand.label, "owner/repo");
    assert_eq!(
        shorthand.cache_path(Path::new("/cache")),
        Path::new("/cache/github.com/owner/repo")
    );
    for input in [
        "github:owner/repo",
        "github.com/owner/repo",
        "git@github.com:owner/repo.git",
        "git+https://github.com/owner/repo.git#fragment",
    ] {
        assert!(shorthand.same(&repository::parse_remote(input, None).unwrap()));
    }
    assert_eq!(
        repository::parse_remote("git@github.com:owner/repo.git", None)
            .unwrap()
            .remote,
        "git@github.com:owner/repo.git"
    );
    assert_eq!(
        repository::parse_remote("gitlab.com/group/repo", None)
            .unwrap()
            .remote,
        "https://gitlab.com/group/repo.git"
    );
    assert_eq!(
        repository::parse_remote("localhost:8080/group/repo", None)
            .unwrap()
            .host,
        "localhost"
    );
    let overridden =
        repository::parse_remote("owner/repo", Some("https://example.test/prefix")).unwrap();
    assert_eq!(
        overridden.remote,
        "https://example.test/prefix/owner/repo.git"
    );
}

#[test]
fn repository_invalid_branches_and_file_references_have_distinct_errors() {
    assert!(matches!(
        repository::parse_remote("file:///tmp/repo.git", None),
        Err(Error::UnsupportedLocalRepository)
    ));
    let file = repository::parse("file:///tmp/repo.git", None).unwrap();
    assert!(file.is_file());
    assert_eq!(file.path, "/tmp/repo.git");
    assert_eq!(file.repo, "repo");
    for bad in [
        "not-a-repo",
        "git@github.com:../../../etc/passwd",
        "-host/owner/repo",
        "a\\b/repo",
        "a/b:c",
    ] {
        assert!(
            matches!(
                repository::parse_remote(bad, None),
                Err(Error::InvalidReference)
            ),
            "{bad}"
        );
    }
    for bad in ["", "-bad", "a..b", "bad branch", "x@{y"] {
        assert!(matches!(
            repository::validate_branch(bad),
            Err(Error::InvalidBranch)
        ));
    }
    for good in ["feature/docs.v1", "main", "a_b-1", "/branch/."] {
        repository::validate_branch(good).unwrap();
    }
}

#[test]
fn repository_root_detection_includes_worktree_gitfiles_and_mercurial_without_vcs_execution() {
    let root = std::env::temp_dir().join(format!(
        "ycoding-repository-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(root.join("main/.git/worktrees/linked")).unwrap();
    fs::create_dir_all(root.join("linked/nested")).unwrap();
    fs::create_dir_all(root.join("mercurial/.hg")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    fs::write(
        root.join("linked/.git"),
        "gitdir: ../main/.git/worktrees/linked\n",
    )
    .unwrap();
    fs::write(root.join("main/.git/worktrees/linked/commondir"), "../..\n").unwrap();
    assert_eq!(
        repository::root(&root.join("linked/nested"))
            .unwrap()
            .unwrap(),
        root.join("linked")
    );
    assert_eq!(
        repository::root(&root.join("mercurial")).unwrap().unwrap(),
        root.join("mercurial")
    );
    assert_eq!(
        repository::root(&root).unwrap(),
        repository::root(root.parent().unwrap()).unwrap()
    );
    fs::remove_dir_all(root).unwrap();
}
