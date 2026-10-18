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

#[tokio::test]
async fn refresh_without_discovered_or_missing_directories_avoids_writer_admission() {
    use std::sync::Arc;
    use ycoding_store::{
        Metadata, Options, Store,
        project::{Directory, DirectoryTable},
    };

    for existing in [false, true] {
        let fixture = Fixture::new();
        let store = Store::disposable(
            Options {
                queue_capacity: 1,
                ..Options::core()
            },
            ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
            Metadata::new([23; 16], 1),
        )
        .unwrap();
        if existing {
            let directory = fixture.0.to_str().unwrap().to_owned();
            store
                .submit(move |tx| {
                    tx.put::<DirectoryTable>(&Directory {
                        project_id: "global".into(),
                        directory: directory.into(),
                        type_: Some("copy".into()),
                        strategy: Some("git_worktree".into()),
                        time_created: 1,
                    })
                })
                .unwrap()
                .wait()
                .unwrap();
        }
        let copies = project_copy::Copies::new(
            &fixture.0,
            Arc::new(Service::new(16 * 1024 * 1024)),
            store.client(),
            Arc::new(|_| Ok(())),
        )
        .unwrap();
        let (started, reached) = std::sync::mpsc::channel();
        let (release, barrier) = std::sync::mpsc::channel();
        let blocked = store
            .submit(move |_| {
                started.send(()).unwrap();
                barrier.recv().unwrap();
                Ok(())
            })
            .unwrap();
        reached
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        let queued = store.submit(|_| Ok(())).unwrap();
        let refreshed = copies.refresh("global".into()).await;
        release.send(()).unwrap();
        blocked.wait().unwrap();
        queued.wait().unwrap();
        refreshed.unwrap();
    }
}
