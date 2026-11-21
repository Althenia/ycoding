use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};
use ycoding_store::{
    Catalog, Error, KeyPart, Metadata, Options, Store, TableDeclaration,
    resources::{Sequence, SequenceTable},
    tuple_key,
};

const CATALOG: Catalog = Catalog::new(1, &[TableDeclaration::of::<SequenceTable>()]);
const BOUND: Duration = Duration::from_secs(5);

fn store(capacity: usize) -> Store {
    Store::disposable(
        Options {
            queue_capacity: capacity,
            ..Options::core()
        },
        CATALOG,
        Metadata::new([29; 16], 1),
    )
    .unwrap()
}

fn row(name: &str) -> Sequence {
    Sequence {
        name: name.into(),
        high_water: 7,
    }
}

fn present(store: &ycoding_store::Client, name: &str) -> bool {
    store
        .snapshot()
        .unwrap()
        .get::<SequenceTable>(&tuple_key(&[KeyPart::String(&name.into())]))
        .unwrap()
        .is_some()
}

#[test]
fn dropped_owned_receipts_commit_once_while_ordinary_receipts_still_cancel() {
    let store = store(3);
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let inflight = store
        .submit(move |_| {
            started.send(()).unwrap();
            blocked.recv_timeout(BOUND).unwrap();
            Ok(())
        })
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    drop(
        store
            .submit(|tx| SequenceTable::insert(tx, &row("ordinary")))
            .unwrap(),
    );
    let observed = Arc::new(AtomicUsize::new(0));
    let (settled, received) = mpsc::channel();
    let client = store.client();
    let count = observed.clone();
    drop(
        store
            .submit_owned(
                |tx| SequenceTable::insert(tx, &row("owned")),
                move |result| {
                    count.fetch_add(1, Ordering::SeqCst);
                    settled
                        .send((result.is_ok(), present(&client, "owned")))
                        .unwrap();
                },
            )
            .unwrap(),
    );
    let before = observed.load(Ordering::SeqCst);
    release.send(()).unwrap();
    inflight.wait().unwrap();
    assert_eq!(before, 0);
    assert_eq!(received.recv_timeout(BOUND).unwrap(), (true, true));
    store.submit(|_| Ok(())).unwrap().wait().unwrap();
    assert_eq!(observed.load(Ordering::SeqCst), 1);
    assert!(present(&store, "owned"));
    assert!(!present(&store, "ordinary"));
}

#[test]
fn an_owned_observer_and_its_captured_lifetime_survive_receipt_drop_until_commit() {
    struct Lifetime(Arc<AtomicUsize>);
    impl Drop for Lifetime {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    let store = store(2);
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let gate = store
        .submit(move |_| {
            started.send(()).unwrap();
            blocked.recv_timeout(BOUND).unwrap();
            Ok(())
        })
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    let released = Arc::new(AtomicUsize::new(0));
    let lifetime = Lifetime(released.clone());
    let client = store.client();
    let (observed, received) = mpsc::channel();
    drop(
        store
            .submit_owned(
                |tx| SequenceTable::insert(tx, &row("lifetime")),
                move |result| {
                    observed
                        .send((result.is_ok(), present(&client, "lifetime")))
                        .unwrap();
                    drop(lifetime);
                },
            )
            .unwrap(),
    );
    let before = released.load(Ordering::SeqCst);
    release.send(()).unwrap();
    gate.wait().unwrap();
    assert_eq!(before, 0);
    assert_eq!(received.recv_timeout(BOUND).unwrap(), (true, true));
    store.submit(|_| Ok(())).unwrap().wait().unwrap();
    assert_eq!(released.load(Ordering::SeqCst), 1);
}

#[test]
fn owned_operation_errors_roll_back_and_reach_the_receipt_and_observer_once() {
    let store = store(2);
    let (observed, received) = mpsc::channel();
    let client = store.client();
    let receipt = store
        .submit_owned(
            |tx| {
                SequenceTable::insert(tx, &row("rollback"))?;
                Err::<(), _>(Error::Rejected("synthetic rejection"))
            },
            move |result| {
                observed
                    .send((
                        matches!(result, Err(Error::Rejected("synthetic rejection"))),
                        present(&client, "rollback"),
                    ))
                    .unwrap();
            },
        )
        .unwrap();
    assert!(matches!(
        receipt.wait(),
        Err(Error::Rejected("synthetic rejection"))
    ));
    assert_eq!(received.recv_timeout(BOUND).unwrap(), (true, false));
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    assert!(!store.is_fenced());
}

#[test]
fn an_observer_panic_preserves_the_committed_receipt_and_fences_later_work() {
    let store = store(2);
    let observed = Arc::new(AtomicUsize::new(0));
    let count = observed.clone();
    let client = store.client();
    let (settled, received) = mpsc::channel();
    let receipt = store
        .submit_owned(
            |tx| {
                SequenceTable::insert(tx, &row("observer-panic"))?;
                Ok(7)
            },
            move |result| {
                count.fetch_add(1, Ordering::SeqCst);
                settled
                    .send((matches!(result, Ok(7)), client.snapshot().unwrap()))
                    .unwrap();
                panic!("synthetic observer panic");
            },
        )
        .unwrap();
    assert_eq!(receipt.wait().unwrap(), 7);
    let (succeeded, snapshot) = received.recv_timeout(BOUND).unwrap();
    assert!(succeeded);
    assert_eq!(
        snapshot
            .get::<SequenceTable>(&tuple_key(&[KeyPart::String(&"observer-panic".into())]))
            .unwrap(),
        Some(row("observer-panic"))
    );
    assert_eq!(observed.load(Ordering::SeqCst), 1);
    assert!(store.is_fenced());
    assert!(matches!(store.snapshot(), Err(Error::WriterFenced)));
    assert!(matches!(store.submit(|_| Ok(())), Err(Error::WriterFenced)));
    drop(snapshot);
    store.shutdown().unwrap();
}

#[test]
fn owned_panic_and_already_queued_fenced_work_each_report_their_terminal_failure() {
    let store = store(2);
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let (first, first_result) = mpsc::channel();
    let panic = store
        .submit_owned(
            move |_| -> Result<(), Error> {
                started.send(()).unwrap();
                blocked.recv_timeout(BOUND).unwrap();
                panic!("synthetic writer panic")
            },
            move |result| {
                first
                    .send(matches!(result, Err(Error::WriterPanicked)))
                    .unwrap()
            },
        )
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    let (second, second_result) = mpsc::channel();
    let queued = store
        .submit_owned(
            |tx| SequenceTable::insert(tx, &row("fenced")),
            move |result| {
                second
                    .send(matches!(result, Err(Error::WriterFenced)))
                    .unwrap()
            },
        )
        .unwrap();
    drop((panic, queued));
    release.send(()).unwrap();
    assert!(first_result.recv_timeout(BOUND).unwrap());
    assert!(second_result.recv_timeout(BOUND).unwrap());
    assert!(matches!(
        first_result.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    assert!(matches!(
        second_result.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    assert!(store.is_fenced());
}

#[test]
fn owned_admission_stays_bounded_and_shutdown_drains_accepted_work() {
    let store = store(1);
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let gate = store
        .submit(move |_| {
            started.send(()).unwrap();
            blocked.recv_timeout(BOUND).unwrap();
            Ok(())
        })
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    let (settled, received) = mpsc::channel();
    drop(
        store
            .submit_owned(
                |tx| SequenceTable::insert(tx, &row("drained")),
                move |result| settled.send(result.is_ok()).unwrap(),
            )
            .unwrap(),
    );
    let rejected = Arc::new(AtomicUsize::new(0));
    let count = rejected.clone();
    let full = store.submit_owned(
        |_| Ok(()),
        move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        },
    );
    release.send(()).unwrap();
    gate.wait().unwrap();
    assert!(matches!(full, Err(Error::QueueFull)));
    let client = store.client();
    store.shutdown().unwrap();
    assert!(received.recv_timeout(BOUND).unwrap());
    assert!(matches!(
        received.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
    let count = rejected.clone();
    assert!(matches!(
        client.submit_owned(
            |_| Ok(()),
            move |_| {
                count.fetch_add(1, Ordering::SeqCst);
            }
        ),
        Err(Error::Closed)
    ));
    assert_eq!(rejected.load(Ordering::SeqCst), 0);
}
