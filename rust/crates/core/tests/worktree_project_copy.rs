pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use ycoding_core::platform::{git::Service, project_copy};

#[test]
fn branch_destinations_do_not_suffix_and_detached_destinations_try_at_most_ten_names() {
    let fixture = Fixture::new();
    fixture.repository();
    let git = Service::new(16 * 1024 * 1024);
    let parent = fixture.0.join("copies");
    let first =
        project_copy::create(&git, &fixture.0, &parent, "feature", Some("feature")).unwrap();
    assert_eq!(first, parent.join("feature"));
    assert!(project_copy::create(&git, &fixture.0, &parent, "feature", Some("feature")).is_err());
    let second = project_copy::create(&git, &fixture.0, &parent, "feature", None).unwrap();
    assert_eq!(second, parent.join("feature-2"));
    let entries = project_copy::list(&git, &fixture.0).unwrap();
    assert_eq!(entries.len(), 3);
    assert!(!entries[0].copy);
    assert!(entries[1..].iter().all(|entry| entry.copy));
    project_copy::remove(&git, &second, false).unwrap();
    assert!(!second.exists());
    for i in 2..=10 {
        std::fs::create_dir_all(parent.join(format!("feature-{i}"))).unwrap();
    }
    assert!(project_copy::create(&git, &fixture.0, &parent, "feature", None).is_err());
    assert!(!parent.join("feature-11").exists());
}
