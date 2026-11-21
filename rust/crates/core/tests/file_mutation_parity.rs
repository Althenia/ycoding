pub mod filesystem_fixture;
use filesystem_fixture::Fixture;
use std::{
    fs,
    sync::{Arc, Barrier},
};
use ycoding_core::platform::filesystem::mutation::{Error, Service, Target};

#[test]
fn writes_create_parents_and_return_stable_resources() {
    let fixture = Fixture::new();
    let service = Service::default();
    let target = Target::new(
        fixture.0.join("src/nested/hello.txt"),
        "src/nested/hello.txt",
    );
    let first = service.write(&target, b"hello").unwrap();
    assert!(!first.existed);
    assert_eq!(first.target, target.canonical);
    assert_eq!(first.resource, "src/nested/hello.txt");
    assert_eq!(first.operation, "write");
    assert!(service.write(&target, b"after").unwrap().existed);
    assert_eq!(fs::read(&target.canonical).unwrap(), b"after");
}

#[test]
fn create_checks_existence_at_commit_and_never_replaces_the_winner() {
    let fixture = Fixture::new();
    let service = Service::default();
    let target = Target::new(fixture.0.join("appeared.txt"), "appeared.txt");
    fixture.write("appeared.txt", "winner");
    assert!(matches!(
        service.create(&target, b"replacement"),
        Err(Error::TargetExists(_))
    ));
    assert_eq!(fs::read(&target.canonical).unwrap(), b"winner");
    fs::remove_file(&target.canonical).unwrap();
    assert!(!service.create(&target, b"after").unwrap().existed);
    let nested = Target::new(fixture.0.join("deep/new.txt"), "deep/new.txt");
    service.create(&nested, &[0, 1, 2]).unwrap();
    assert_eq!(fs::read(&nested.canonical).unwrap(), [0, 1, 2]);
}

#[test]
fn text_writes_preserve_existing_bom_and_emit_at_most_one() {
    let fixture = Fixture::new();
    let service = Service::default();
    let target = Target::new(
        fixture.write("preserved.txt", "\u{feff}before"),
        "preserved.txt",
    );
    service.write_text_preserving_bom(&target, "after").unwrap();
    assert_eq!(
        fs::read_to_string(&target.canonical).unwrap(),
        "\u{feff}after"
    );
    service
        .write_text_preserving_bom(&target, "\u{feff}\u{feff}next")
        .unwrap();
    assert_eq!(
        fs::read_to_string(&target.canonical).unwrap(),
        "\u{feff}next"
    );
    let created = Target::new(fixture.0.join("created.txt"), "created.txt");
    assert!(
        !service
            .write_text_preserving_bom(&created, "\u{feff}\u{feff}\u{feff}created")
            .unwrap()
            .existed
    );
    assert_eq!(
        fs::read_to_string(&created.canonical).unwrap(),
        "\u{feff}created"
    );
}

#[test]
fn stale_conditional_writes_do_not_change_bytes_and_missing_targets_are_errors() {
    let fixture = Fixture::new();
    let service = Service::default();
    let target = Target::new(fixture.write("stale.txt", "current"), "stale.txt");
    assert!(matches!(
        service.write_if_unchanged(&target, b"older", b"replacement"),
        Err(Error::StaleContent(_))
    ));
    assert_eq!(fs::read(&target.canonical).unwrap(), b"current");
    fs::remove_file(&target.canonical).unwrap();
    assert!(matches!(
        service.write_if_unchanged(&target, b"current", b"replacement"),
        Err(Error::Io(_))
    ));
    assert!(!target.canonical.exists());
}

#[test]
fn exactly_one_concurrent_conditional_write_can_use_the_same_bytes() {
    let fixture = Fixture::new();
    let service = Arc::new(Service::default());
    let target = Arc::new(Target::new(
        fixture.write("shared.txt", "initial"),
        "shared.txt",
    ));
    let ready = Arc::new(Barrier::new(3));
    let workers: Vec<_> = [b"first".as_slice(), b"second".as_slice()]
        .into_iter()
        .map(|content| {
            let service = service.clone();
            let target = target.clone();
            let ready = ready.clone();
            std::thread::spawn(move || {
                ready.wait();
                service.write_if_unchanged(&target, b"initial", content)
            })
        })
        .collect();
    ready.wait();
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, Err(Error::StaleContent(_))))
            .count(),
        1
    );
    assert!(
        [b"first".as_slice(), b"second".as_slice()]
            .contains(&fs::read(&target.canonical).unwrap().as_slice())
    );
}

#[test]
fn removals_report_existence_and_preserve_nonempty_directories() {
    let fixture = Fixture::new();
    let service = Service::default();
    let target = Target::new(fixture.write("remove.txt", "remove"), "remove.txt");
    let removed = service.remove(&target).unwrap();
    assert!(removed.existed);
    assert_eq!(removed.operation, "remove");
    assert!(!service.remove(&target).unwrap().existed);
    fixture.write("dir/child.txt", "keep");
    let directory = Target::new(fixture.0.join("dir"), "dir");
    assert!(service.remove(&directory).is_err());
    assert_eq!(fs::read(fixture.0.join("dir/child.txt")).unwrap(), b"keep");
}

#[test]
fn explicitly_resolved_external_targets_keep_their_canonical_resource() {
    let outside = Fixture::new();
    let service = Service::default();
    let path = outside.0.join("external.txt");
    let target = Target::new(path.clone(), path.to_str().unwrap());
    let result = service.write(&target, b"external").unwrap();
    assert_eq!(result.target, path);
    assert_eq!(result.resource, target.resource);
    assert!(!result.existed);
    assert_eq!(fs::read(&path).unwrap(), b"external");
    let result = service.remove(&target).unwrap();
    assert!(result.existed);
    assert_eq!(result.resource, target.resource);
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn distinct_canonical_targets_progress_while_another_target_is_blocked() {
    use std::{io::Read, process::Command, sync::mpsc, time::Duration};
    let fixture = Fixture::new();
    let fifo = fixture.0.join("blocked");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let blocked = Target::new(fifo.clone(), "blocked");
    let independent = Target::new(fixture.0.join("independent"), "independent");
    let service = Arc::new(Service::default());
    let writer_service = service.clone();
    let writer =
        std::thread::spawn(move || writer_service.write(&blocked, &vec![7; 4 * 1024 * 1024]));
    let (opened, observed) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut file = fs::File::open(fifo).unwrap();
        opened.send(()).unwrap();
        resume.recv().unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        bytes
    });
    observed.recv_timeout(Duration::from_secs(5)).unwrap();
    let (finished, completion) = mpsc::channel();
    let other = std::thread::spawn(move || {
        finished
            .send(service.write(&independent, b"independent"))
            .unwrap()
    });
    let completed = completion.recv_timeout(Duration::from_secs(5));
    release.send(()).unwrap();
    writer.join().unwrap().unwrap();
    assert_eq!(reader.join().unwrap(), vec![7; 4 * 1024 * 1024]);
    other.join().unwrap();
    assert!(completed.unwrap().is_ok());
    assert_eq!(
        fs::read(fixture.0.join("independent")).unwrap(),
        b"independent"
    );
}
