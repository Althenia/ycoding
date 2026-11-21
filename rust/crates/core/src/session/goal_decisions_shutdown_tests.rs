use super::*;
use std::task::{Context, Poll, Waker};
use tokio::sync::oneshot;

fn work() -> [Arc<Mutex<Work>>; 2] {
    std::array::from_fn(|_| Arc::new(Mutex::new(Work::default())))
}

fn started(work: [Arc<Mutex<Work>>; 2], tasks: Vec<(Worker, JoinHandle<()>)>) -> Started {
    Started::new(watch::channel(false).0, work, tasks)
}

fn pending(future: Pin<&mut impl Future>) {
    assert!(
        future
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
}

#[tokio::test]
async fn shutdown_stops_admission_joins_nested_work_and_repeats_success() {
    let work = work();
    let (release, wait) = oneshot::channel();
    let (done, completed) = oneshot::channel();
    assert!(locked_work(&work[0]).spawn(async move {
        wait.await.unwrap();
        done.send(()).unwrap();
    }));
    let owner = started(work.clone(), Vec::new());
    let mut drain = Box::pin(owner.shutdown());
    pending(drain.as_mut());
    assert!(!locked_work(&work[0]).spawn(async { panic!("unadmitted synthetic work") }));
    assert!(!locked_work(&work[1]).spawn(async { panic!("unadmitted synthetic work") }));
    release.send(()).unwrap();
    assert_eq!(drain.await, Ok(()));
    completed.await.unwrap();
    assert_eq!(owner.shutdown().await, Ok(()));
}

#[tokio::test]
async fn shutdown_retains_outer_and_nested_failures_and_finishes_later_work() {
    let work = work();
    assert!(locked_work(&work[0]).spawn(async { panic!("synthetic private panic") }));
    let (done, completed) = oneshot::channel();
    assert!(locked_work(&work[1]).spawn(async move { done.send(()).unwrap() }));
    let owner = started(
        work,
        vec![(
            Worker::Events,
            tokio::spawn(async { panic!("synthetic outer panic") }),
        )],
    );
    let error = owner.shutdown().await.unwrap_err();
    completed.await.unwrap();
    assert_eq!(
        error.failures(),
        &[
            ShutdownFailure {
                worker: Worker::Events,
                task: None,
                kind: JoinFailure::Panic
            },
            ShutdownFailure {
                worker: Worker::Events,
                task: Some(0),
                kind: JoinFailure::Panic
            },
        ]
    );
    assert!(!format!("{error:?} {error}").contains("synthetic"));
    assert_eq!(owner.shutdown().await, Err(error));
}

#[tokio::test]
async fn unexpected_outer_and_nested_cancellation_are_not_success() {
    let work = work();
    locked_work(&work[1]).spawn(std::future::pending());
    locked_work(&work[1]).tasks.abort_all();
    let task = tokio::spawn(std::future::pending());
    task.abort();
    let owner = started(work, vec![(Worker::Reconciliation, task)]);
    let error = owner.shutdown().await.unwrap_err();
    assert_eq!(
        error.failures(),
        &[
            ShutdownFailure {
                worker: Worker::Reconciliation,
                task: None,
                kind: JoinFailure::Cancelled
            },
            ShutdownFailure {
                worker: Worker::Reconciliation,
                task: Some(0),
                kind: JoinFailure::Cancelled
            },
        ]
    );
}

#[tokio::test]
async fn cancelled_shutdown_resumes_the_same_outer_and_nested_tasks() {
    let work = work();
    let (release, wait) = oneshot::channel();
    let outer = tokio::spawn(async move { wait.await.unwrap() });
    locked_work(&work[0]).spawn(async { panic!("synthetic nested panic") });
    let owner = started(work, vec![(Worker::Events, outer)]);
    let mut drain = Box::pin(owner.shutdown());
    pending(drain.as_mut());
    drop(drain);
    release.send(()).unwrap();
    let (first, second) = tokio::join!(owner.shutdown(), owner.shutdown());
    assert_eq!(first, second);
    assert_eq!(
        first.unwrap_err().failures(),
        &[ShutdownFailure {
            worker: Worker::Events,
            task: Some(0),
            kind: JoinFailure::Panic
        },]
    );
}

#[tokio::test]
async fn reaped_failures_survive_shutdown_in_admission_order() {
    let work = work();
    let (release, wait) = oneshot::channel();
    locked_work(&work[0]).spawn(async move {
        wait.await.unwrap();
        panic!("synthetic first panic")
    });
    locked_work(&work[0]).spawn(async { panic!("synthetic second panic") });
    std::future::poll_fn(|cx| {
        let mut work = locked_work(&work[0]);
        match work.tasks.poll_join_next_with_id(cx) {
            Poll::Ready(Some(result)) => {
                work.record(result);
                Poll::Ready(())
            }
            Poll::Ready(None) => panic!("missing work"),
            Poll::Pending => Poll::Pending,
        }
    })
    .await;
    release.send(()).unwrap();
    let owner = started(work, Vec::new());
    let error = owner.shutdown().await.unwrap_err();
    assert_eq!(
        error
            .failures()
            .iter()
            .map(|failure| failure.task)
            .collect::<Vec<_>>(),
        [Some(0), Some(1)]
    );
}

#[tokio::test]
async fn intentional_stop_joins_outer_workers_without_cancellation_failure() {
    let work = work();
    let (stop, mut stopped) = watch::channel(false);
    let outer = tokio::spawn(async move {
        stopped.wait_for(|stopped| *stopped).await.unwrap();
    });
    let owner = Started::new(stop, work, vec![(Worker::Events, outer)]);
    assert_eq!(owner.shutdown().await, Ok(()));
}

#[tokio::test]
async fn drop_is_abort_only_for_outer_and_nested_work() {
    let work = work();
    locked_work(&work[0]).spawn(std::future::pending());
    let (entered, ready) = oneshot::channel();
    let (done, completed) = oneshot::channel();
    struct Signal(Option<oneshot::Sender<()>>);
    impl Drop for Signal {
        fn drop(&mut self) {
            self.0.take().unwrap().send(()).unwrap();
        }
    }
    let outer = tokio::spawn(async move {
        let _signal = Signal(Some(done));
        entered.send(()).unwrap();
        std::future::pending::<()>().await;
    });
    ready.await.unwrap();
    let owner = started(work.clone(), vec![(Worker::Events, outer)]);
    drop(owner);
    completed.await.unwrap();
    let result = std::future::poll_fn(|cx| locked_work(&work[0]).tasks.poll_join_next(cx))
        .await
        .unwrap();
    assert!(result.unwrap_err().is_cancelled());
}
