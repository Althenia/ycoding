use ycoding_store::{Catalog, Error, Metadata, Options, Store};

#[test]
fn canonical_owner_limits_match_the_selected_core_and_meeting_budgets() {
    let core = Options::core();
    let meeting = Options::meeting();
    assert_eq!(
        (core.cache_bytes, core.queue_capacity, core.max_snapshots),
        (128 * 1024 * 1024, 256, 64)
    );
    assert_eq!(
        (
            meeting.cache_bytes,
            meeting.queue_capacity,
            meeting.max_snapshots
        ),
        (64 * 1024 * 1024, 256, 64)
    );
    for options in [
        Options {
            cache_bytes: 0,
            ..core
        },
        Options {
            cache_bytes: core.cache_bytes + 1,
            ..core
        },
        Options {
            queue_capacity: 0,
            ..core
        },
        Options {
            queue_capacity: 257,
            ..core
        },
        Options {
            max_snapshots: 0,
            ..core
        },
        Options {
            max_snapshots: 257,
            ..core
        },
    ] {
        assert!(matches!(
            Store::disposable(options, Catalog::new(1, &[]), Metadata::new([1; 16], 1)),
            Err(Error::InvalidConfiguration(_))
        ));
    }
}

#[test]
fn snapshot_capacity_and_shutdown_are_owner_local_and_release_exactly_once() {
    let options = Options {
        max_snapshots: 2,
        ..Options::core()
    };
    let first =
        Store::disposable(options, Catalog::new(1, &[]), Metadata::new([1; 16], 1)).unwrap();
    let second =
        Store::disposable(options, Catalog::new(1, &[]), Metadata::new([2; 16], 1)).unwrap();
    let held = [first.snapshot().unwrap(), first.snapshot().unwrap()];
    assert!(matches!(first.snapshot(), Err(Error::SnapshotLimit)));
    let peer = second.snapshot().unwrap();
    drop(held);
    let next = [first.snapshot().unwrap(), first.snapshot().unwrap()];
    assert!(matches!(first.snapshot(), Err(Error::SnapshotLimit)));
    drop(next);
    drop(peer);
    let closed = first.client();
    first.shutdown().unwrap();
    assert!(matches!(closed.snapshot(), Err(Error::Closed)));
    assert!(second.snapshot().is_ok());
    second.shutdown().unwrap();
}
