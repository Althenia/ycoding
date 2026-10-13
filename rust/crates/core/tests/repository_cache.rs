pub mod filesystem_fixture;
use filesystem_fixture::{Fixture, git};
use std::{
    fs,
    path::Path,
    sync::{Arc, Barrier, mpsc},
    time::Duration,
};
use ycoding_core::{
    platform::{
        git::Service,
        repository_cache::{self, EnsureInput, Error, Status},
    },
    resources::discovery::repository::{self, Reference},
};

struct Remote {
    fixture: Fixture,
    reference: Reference,
}
impl Remote {
    fn new() -> Self {
        let fixture = Fixture::new();
        fixture.git(&["init", "--bare", "origin.git"]);
        fs::create_dir(fixture.0.join("source")).unwrap();
        let source = fixture.0.join("source");
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Test"]);
        git(&source, &["config", "user.email", "test@ycoding.test"]);
        git(&source, &["config", "commit.gpgsign", "false"]);
        let remote = url::Url::from_file_path(fixture.0.join("origin.git"))
            .unwrap()
            .to_string();
        git(&source, &["remote", "add", "origin", &remote]);
        fs::write(source.join("README.md"), "one\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "initial"]);
        git(&source, &["push", "-u", "origin", "main"]);
        fixture.git(&[
            "--git-dir",
            "origin.git",
            "symbolic-ref",
            "HEAD",
            "refs/heads/main",
        ]);
        let mut reference = repository::parse_remote("owner/repo", None).unwrap();
        reference.remote = remote;
        Self { fixture, reference }
    }
    fn cache(&self) -> repository_cache::Service {
        repository_cache::Service::new(
            self.fixture.0.join("repos"),
            self.fixture.0.join("state"),
            Arc::new(Service::new(16 * 1024 * 1024)),
        )
    }
    fn ensure(
        &self,
        cache: &repository_cache::Service,
        refresh: bool,
        branch: Option<&str>,
    ) -> Result<repository_cache::Ensured, Error> {
        cache.ensure(EnsureInput {
            reference: &self.reference,
            refresh,
            branch,
        })
    }
    fn commit(&self, text: &str) {
        let source = self.fixture.0.join("source");
        fs::write(source.join("README.md"), text).unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "update"]);
        git(&source, &["push"]);
    }
}

#[test]
fn clones_stale_directory_and_reports_identity_head_and_branch() {
    let remote = Remote::new();
    let target = remote.reference.cache_path(&remote.fixture.0.join("repos"));
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("stale.txt"), "stale").unwrap();
    let result = remote.ensure(&remote.cache(), false, None).unwrap();
    assert_eq!(result.status, Status::Cloned);
    assert_eq!(result.local_path, target);
    assert_eq!(result.repository, "owner/repo");
    assert_eq!(result.host, "github.com");
    assert_eq!(result.remote, remote.reference.remote);
    assert_eq!(result.branch.as_deref(), Some("main"));
    assert_eq!(
        result.head.unwrap(),
        git(&remote.fixture.0.join("source"), &["rev-parse", "HEAD"])
    );
    assert!(!target.join("stale.txt").exists());
    assert_eq!(
        fs::read_to_string(target.join("README.md")).unwrap(),
        "one\n"
    );
}

#[test]
fn cached_checkout_preserves_changes_but_refresh_fetches_and_resets() {
    let remote = Remote::new();
    let cache = remote.cache();
    let first = remote.ensure(&cache, false, None).unwrap();
    remote.commit("two\n");
    fs::write(first.local_path.join("README.md"), "local\n").unwrap();
    let cached = remote.ensure(&cache, false, Some("main")).unwrap();
    assert_eq!(cached.status, Status::Cached);
    assert_eq!(cached.head, first.head);
    assert_eq!(
        fs::read_to_string(cached.local_path.join("README.md")).unwrap(),
        "local\n"
    );
    let refreshed = remote.ensure(&cache, true, None).unwrap();
    assert_eq!(refreshed.status, Status::Refreshed);
    assert_ne!(refreshed.head, first.head);
    assert_eq!(
        fs::read_to_string(refreshed.local_path.join("README.md")).unwrap(),
        "two\n"
    );
}

#[test]
fn stale_files_missing_origins_and_wrong_origins_are_replaced() {
    let remote = Remote::new();
    let cache = remote.cache();
    let path = remote.reference.cache_path(&remote.fixture.0.join("repos"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "not a directory").unwrap();
    assert_eq!(
        remote.ensure(&cache, false, None).unwrap().status,
        Status::Cloned
    );
    for origin in [None, Some("https://example.test/other/repo.git")] {
        if let Some(origin) = origin {
            git(&path, &["config", "remote.origin.url", origin]);
        } else {
            git(&path, &["remote", "remove", "origin"]);
        }
        fs::write(path.join("stale.txt"), "stale").unwrap();
        assert_eq!(
            remote.ensure(&cache, false, None).unwrap().status,
            Status::Cloned
        );
        assert!(!path.join("stale.txt").exists());
    }
}

#[test]
fn origin_identity_is_normalized_and_compared_to_actual_clone_target() {
    let remote = Remote::new();
    let cache = remote.cache();
    let first = remote.ensure(&cache, false, None).unwrap();
    git(
        &first.local_path,
        &[
            "remote",
            "set-url",
            "origin",
            &format!("git+{}#ignored", remote.reference.remote),
        ],
    );
    assert_eq!(
        remote.ensure(&cache, false, None).unwrap().status,
        Status::Cached
    );
}

#[test]
fn branch_mismatch_fetches_explicit_branch_and_resets_it() {
    let remote = Remote::new();
    let cache = remote.cache();
    remote.ensure(&cache, false, None).unwrap();
    let source = remote.fixture.0.join("source");
    git(&source, &["checkout", "-b", "feature/docs"]);
    git(&source, &["push", "-u", "origin", "feature/docs"]);
    remote.commit("feature\n");
    git(&source, &["push", "-u", "origin", "feature/docs"]);
    let result = remote.ensure(&cache, false, Some("feature/docs")).unwrap();
    assert_eq!(result.status, Status::Refreshed);
    assert_eq!(result.branch.as_deref(), Some("feature/docs"));
    assert_eq!(
        fs::read_to_string(result.local_path.join("README.md")).unwrap(),
        "feature\n"
    );
    assert_eq!(
        remote
            .ensure(&cache, false, Some("feature/docs"))
            .unwrap()
            .status,
        Status::Cached
    );
}

#[test]
fn clone_accepts_tag_but_refresh_requires_a_remote_branch() {
    let remote = Remote::new();
    git(&remote.fixture.0.join("source"), &["tag", "v1"]);
    git(&remote.fixture.0.join("source"), &["push", "origin", "v1"]);
    let cache = remote.cache();
    let result = remote.ensure(&cache, false, Some("v1")).unwrap();
    assert_eq!(result.status, Status::Cloned);
    assert!(result.branch.is_none());
    assert!(matches!(
        remote.ensure(&cache, false, Some("v1")),
        Err(Error::FetchFailed { .. })
    ));
}

#[test]
fn reset_falls_back_to_current_branch_then_head_when_remote_head_is_absent() {
    let remote = Remote::new();
    let cache = remote.cache();
    let path = remote.ensure(&cache, false, None).unwrap().local_path;
    git(
        &path,
        &["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"],
    );
    remote.commit("two\n");
    assert_eq!(
        remote.ensure(&cache, true, None).unwrap().branch.as_deref(),
        Some("main")
    );
    assert_eq!(fs::read_to_string(path.join("README.md")).unwrap(), "two\n");
    git(&path, &["checkout", "--detach"]);
    fs::write(path.join("README.md"), "dirty\n").unwrap();
    let result = remote.ensure(&cache, true, None).unwrap();
    assert!(result.branch.is_none());
    assert_eq!(fs::read_to_string(path.join("README.md")).unwrap(), "two\n");
}

#[test]
fn validation_clone_fetch_and_reset_failures_keep_their_fields_and_release_locks() {
    assert_eq!(
        repository_cache::parse_remote("invalid", None).unwrap_err(),
        Error::InvalidRepository {
            repository: "invalid".into(),
            message: repository::Error::InvalidReference.to_string()
        }
    );
    assert!(
        matches!(repository_cache::parse_remote("file:///tmp/repo.git", None), Err(Error::InvalidRepository { message, .. }) if message == "Local file repositories are not supported")
    );
    let remote = Remote::new();
    let cache = remote.cache();
    assert_eq!(
        remote.ensure(&cache, false, Some("../unsafe")).unwrap_err(),
        Error::InvalidBranch {
            branch: "../unsafe".into(),
            message: repository::Error::InvalidBranch.to_string()
        }
    );
    assert!(!remote.fixture.0.join("state").exists());
    let missing = Reference {
        remote: url::Url::from_file_path(remote.fixture.0.join("missing.git"))
            .unwrap()
            .into(),
        ..remote.reference.clone()
    };
    assert!(
        matches!(cache.ensure(EnsureInput { reference: &missing, branch: None, refresh: false }), Err(Error::CloneFailed { repository, message }) if repository == "owner/repo" && message.contains("missing.git"))
    );
    let result = remote.ensure(&cache, false, None).unwrap();
    fs::rename(
        remote.fixture.0.join("origin.git"),
        remote.fixture.0.join("away.git"),
    )
    .unwrap();
    assert!(
        matches!(remote.ensure(&cache, true, None), Err(Error::FetchFailed { repository, message }) if repository == "owner/repo" && !message.is_empty())
    );
    fs::rename(
        remote.fixture.0.join("away.git"),
        remote.fixture.0.join("origin.git"),
    )
    .unwrap();
    git(
        &result.local_path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/missing",
        ],
    );
    assert!(
        matches!(remote.ensure(&cache, true, None), Err(Error::ResetFailed { repository, message }) if repository == "owner/repo" && message.contains("origin/missing"))
    );
    git(
        &result.local_path,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ],
    );
    assert_eq!(
        remote.ensure(&cache, true, Some("")).unwrap().status,
        Status::Refreshed
    );
}

#[test]
fn checkout_failure_is_typed_and_does_not_reset_the_checkout() {
    let remote = Remote::new();
    let cache = remote.cache();
    let first = remote.ensure(&cache, false, None).unwrap();
    let source = remote.fixture.0.join("source");
    git(&source, &["checkout", "-b", "feature/docs"]);
    fs::write(source.join("feature.txt"), "tracked\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "feature"]);
    git(&source, &["push", "-u", "origin", "feature/docs"]);
    fs::write(first.local_path.join("feature.txt"), "untracked\n").unwrap();
    assert!(
        matches!(remote.ensure(&cache, false, Some("feature/docs")), Err(Error::CheckoutFailed { repository, branch, message }) if repository == "owner/repo" && branch == "feature/docs" && message.contains("feature.txt"))
    );
    assert_eq!(
        git(&first.local_path, &["branch", "--show-current"]),
        "main"
    );
    assert_eq!(
        fs::read_to_string(first.local_path.join("feature.txt")).unwrap(),
        "untracked\n"
    );
}

#[test]
fn filesystem_and_lock_failures_are_typed() {
    let fixture = Fixture::new();
    let reference = repository::parse_remote("owner/repo", None).unwrap();
    fs::write(fixture.0.join("state"), "file").unwrap();
    let cache = repository_cache::Service::new(
        fixture.0.join("repos"),
        fixture.0.join("state"),
        Arc::new(Service::new(1024)),
    );
    assert!(
        matches!(cache.ensure(EnsureInput { reference: &reference, refresh: false, branch: None }), Err(Error::LockFailed { local_path, message }) if local_path.ends_with("github.com/owner/repo") && !message.is_empty())
    );
    fs::write(fixture.0.join("blocked"), "file").unwrap();
    let cache = repository_cache::Service::new(
        fixture.0.join("blocked/repos"),
        fixture.0.join("valid-state"),
        Arc::new(Service::new(1024)),
    );
    assert!(
        matches!(cache.ensure(EnsureInput { reference: &reference, refresh: false, branch: None }), Err(Error::CacheOperation { operation: "ensure cache directory", path, message }) if path.ends_with("github.com/owner/repo") && !message.is_empty())
    );
}

#[test]
fn concurrent_ensures_on_the_same_target_serialize_even_across_service_instances() {
    let remote = Remote::new();
    let barrier = Arc::new(Barrier::new(2));
    let results = std::thread::scope(|scope| {
        let one = scope.spawn(|| {
            barrier.wait();
            remote.ensure(&remote.cache(), false, None).unwrap()
        });
        let two = scope.spawn(|| {
            barrier.wait();
            remote.ensure(&remote.cache(), false, None).unwrap()
        });
        [one.join().unwrap(), two.join().unwrap()]
    });
    assert_eq!(results[0].local_path, results[1].local_path);
    assert!(results.iter().any(|r| r.status == Status::Cloned));
    assert!(results.iter().any(|r| r.status == Status::Cached));
}

fn held_lock(state: &Path, target: &Path) -> fs::File {
    fs::create_dir_all(state.join("locks/repository-cache")).unwrap();
    let hash = ring::digest::digest(
        &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
        format!("repository-cache:{}", target.display()).as_bytes(),
    )
    .as_ref()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect::<String>();
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(state.join(format!("locks/repository-cache/{hash}.lock")))
        .unwrap();
    file.lock().unwrap();
    file
}

#[test]
fn a_locked_repository_does_not_block_other_repositories() {
    let remote = Remote::new();
    let cache = remote.cache();
    let other = Reference {
        segments: vec!["owner".into(), "other".into()],
        path: "owner/other".into(),
        label: "owner/other".into(),
        repo: "other".into(),
        ..remote.reference.clone()
    };
    let lock = held_lock(
        &remote.fixture.0.join("state"),
        &remote.reference.cache_path(&remote.fixture.0.join("repos")),
    );
    let (send, receive) = mpsc::channel();
    std::thread::scope(|scope| {
        let waiting = scope.spawn(|| remote.ensure(&cache, false, None).unwrap());
        let independent = scope.spawn(|| {
            send.send(
                cache
                    .ensure(EnsureInput {
                        reference: &other,
                        refresh: false,
                        branch: None,
                    })
                    .unwrap(),
            )
            .unwrap();
        });
        let result = receive.recv_timeout(Duration::from_secs(20));
        drop(lock);
        assert_eq!(result.unwrap().status, Status::Cloned);
        assert_eq!(waiting.join().unwrap().status, Status::Cloned);
        independent.join().unwrap();
    });
}
