pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{fs, time::Duration};
use ycoding_core::platform::filesystem::watcher::{
    Input, Kind, LocationWatcher, Service, UpdateKind,
};
use ycoding_core::platform::git;
use ycoding_schema::filesystem::ChangedKind;

async fn next(
    subscription: &mut ycoding_core::platform::filesystem::watcher::Subscription,
    path: &std::path::Path,
    kind: UpdateKind,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = subscription.recv().await.unwrap();
            if event.path == path && event.kind == kind {
                break;
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn real_recursive_watch_publishes_create_update_delete_and_shared_lifetime() {
    let fixture = Fixture::new();
    let service = Service::new(true);
    let input = Input {
        path: fixture.0.clone(),
        kind: Kind::Directory,
        ignore: Vec::new(),
    };
    let mut first = service.subscribe(input.clone()).unwrap();
    let mut second = service.subscribe(input).unwrap();
    let path = fixture.write("watched.txt", "created");
    next(&mut first, &path, UpdateKind::Create).await;
    next(&mut second, &path, UpdateKind::Create).await;
    drop(first);
    fs::write(&path, "updated").unwrap();
    next(&mut second, &path, UpdateKind::Update).await;
    fs::remove_file(&path).unwrap();
    next(&mut second, &path, UpdateKind::Delete).await;
    drop(second);
    assert_eq!(service.active_count().unwrap(), 0);
}

#[tokio::test]
async fn exact_file_watch_ignores_siblings_and_reports_updates_for_created_target() {
    let fixture = Fixture::new();
    let service = Service::new(true);
    let path = fixture.0.join("ycoding.json");
    let mut subscription = service
        .subscribe(Input {
            path: path.clone(),
            kind: Kind::File,
            ignore: Vec::new(),
        })
        .unwrap();
    fixture.write("sibling.json", "sibling");
    fs::write(&path, "target").unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), subscription.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.path, path);
    assert_eq!(event.kind, UpdateKind::Update);
}

#[tokio::test]
async fn location_watch_filters_nested_builds_and_git_index_but_keeps_head() {
    let fixture = Fixture::new();
    fixture.repository();
    fixture.git(&["read-tree", "HEAD"]);
    let watcher = Service::new(true);
    let git = git::Service::new(16 * 1024 * 1024);
    let mut location = LocationWatcher::start(
        &watcher,
        &git,
        &fixture.0,
        &fixture.0.join("home"),
        "darwin",
        true,
        &[],
    )
    .unwrap();
    fixture.write("nested/node_modules/package/index.js", "ignored");
    fixture.write("nested/dist/index.js", "ignored");
    fixture.write(".git/index", "ignored");
    let sentinel = fixture.write("visible.txt", "visible");
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = location.recv().await.unwrap();
            let file = event.file.to_utf8().unwrap();
            assert!(
                !file.contains("node_modules")
                    && !file.contains("nested/dist")
                    && !file.ends_with(".git/index")
            );
            if file == sentinel.to_str().unwrap() {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(event.file.to_utf8().unwrap(), sentinel.to_str().unwrap());
    assert_eq!(event.event, ChangedKind::Add);
    fixture.write(".git/HEAD", "ref: refs/heads/other\n");
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = location.recv().await.unwrap();
            let file = event.file.to_utf8().unwrap();
            assert!(
                !file.contains("node_modules")
                    && !file.contains("nested/dist")
                    && !file.ends_with(".git/index")
            );
            if file.ends_with(".git/HEAD") {
                break event;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        event.file.to_utf8().unwrap(),
        fixture.0.join(".git/HEAD").to_str().unwrap()
    );
    assert_eq!(event.event, ChangedKind::Change);
}

#[tokio::test]
async fn non_vcs_home_disabled_and_configured_git_ignores_have_no_subscriptions() {
    let fixture = Fixture::new();
    let watcher = Service::new(true);
    let git = git::Service::new(16 * 1024 * 1024);
    let plain = LocationWatcher::start(
        &watcher,
        &git,
        &fixture.0,
        &fixture.0.join("home"),
        "darwin",
        false,
        &[],
    )
    .unwrap();
    assert_eq!(watcher.active_count().unwrap(), 0);
    drop(plain);
    fixture.repository();
    let home = LocationWatcher::start(
        &watcher,
        &git,
        &fixture.0,
        &fixture.0,
        "darwin",
        true,
        &[".git".into()],
    )
    .unwrap();
    assert_eq!(watcher.active_count().unwrap(), 0);
    drop(home);
    let disabled = Service::new(false);
    let mut subscription = disabled
        .subscribe(Input {
            path: fixture.0.clone(),
            kind: Kind::Directory,
            ignore: Vec::new(),
        })
        .unwrap();
    assert!(subscription.recv().await.is_err());
}

#[tokio::test]
async fn directory_rename_publishes_deleted_source_and_created_destination() {
    let fixture = Fixture::new();
    let source = fixture.write("source.txt", "before");
    let target = fixture.0.join("renamed.txt");
    let service = Service::new(true);
    let mut subscription = service
        .subscribe(Input {
            path: fixture.0.clone(),
            kind: Kind::Directory,
            ignore: Vec::new(),
        })
        .unwrap();
    fs::rename(&source, &target).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut deleted = false;
        let mut created = false;
        while !deleted || !created {
            let update = subscription.recv().await.unwrap();
            deleted |= update.path == source && update.kind == UpdateKind::Delete;
            created |= update.path == target && update.kind == UpdateKind::Create;
        }
    })
    .await
    .unwrap();
}
