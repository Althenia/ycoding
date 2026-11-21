pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::fs;
use ycoding_core::platform::{git::Service, worktree};

#[test]
fn named_worktrees_share_objects_keep_location_and_reject_invalid_or_duplicate_names() {
    let fixture = Fixture::new();
    fixture.repository();
    let service = Service::new(16 * 1024 * 1024);
    let repository = service.discover(&fixture.0).unwrap().unwrap();
    let target = fixture.0.join(".worktrees/feature-one");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let linked = worktree::create(&service, &repository, &target, Some("feature-one")).unwrap();
    assert_eq!(linked.worktree, fs::canonicalize(&target).unwrap());
    assert_eq!(linked.common_directory, repository.common_directory);
    assert_ne!(linked.git_directory, repository.git_directory);
    assert_eq!(
        service.branch(&linked).unwrap().as_deref(),
        Some("feature-one")
    );
    assert_eq!(
        service.branch(&repository).unwrap().as_deref(),
        Some("main")
    );
    let entries = worktree::list(&service, &repository).unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries[0].main);
    assert_eq!(entries[1].directory, target);
    assert!(worktree::create(&service, &repository, &target, Some("feature-one")).is_err());
    for name in [
        "Bad_name",
        "feature/one",
        "-bad",
        "",
        "UPPER",
        &"a".repeat(64),
    ] {
        assert!(
            worktree::create(
                &service,
                &repository,
                &fixture.0.join("invalid"),
                Some(name)
            )
            .is_err()
        );
        assert!(!fixture.0.join("invalid").exists());
    }
    fixture.write(".worktrees/feature-one/untracked", "dirty");
    let error = worktree::remove(&service, &linked, &target, false).unwrap_err();
    assert!(error.force_required);
    assert!(target.exists());
    worktree::remove(&service, &linked, &target, true).unwrap();
    assert!(!target.exists());
    assert_eq!(worktree::list(&service, &repository).unwrap().len(), 1);
}

#[test]
fn managed_destination_hashes_the_canonical_common_directory_and_does_not_detach() {
    let fixture = Fixture::new();
    fixture.repository();
    let service = Service::new(16 * 1024 * 1024);
    let repository = service.discover(&fixture.0).unwrap().unwrap();
    let data = fixture.0.join("data");
    let destination = worktree::managed_destination(&data, &repository, "feature-two").unwrap();
    assert_eq!(destination.file_name().unwrap(), "feature-two");
    assert_eq!(
        destination
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .len(),
        69
    );
    assert!(destination.starts_with(data.join("worktrees")));
    let linked = worktree::create_managed(&service, &repository, &data, "feature-two").unwrap();
    assert_eq!(linked.worktree, destination);
    assert_eq!(
        service.branch(&linked).unwrap().as_deref(),
        Some("feature-two")
    );
    assert!(worktree::create_managed(&service, &repository, &data, "feature-two").is_err());
    worktree::remove(&service, &repository, &destination, true).unwrap();
}
