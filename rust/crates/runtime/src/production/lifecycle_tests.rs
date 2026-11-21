use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::{Notify, Semaphore};

#[tokio::test]
async fn shutdown_waiters_resume_one_cleanup_and_receive_the_same_failure() {
    let shutdown = Shutdown::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let work = {
        let (calls, entered, release) = (calls.clone(), entered.clone(), release.clone());
        move || async move {
            calls.fetch_add(1, Ordering::SeqCst);
            entered.notify_one();
            release.acquire().await.unwrap().forget();
            Err(unavailable("synthetic owner"))
        }
    };
    let mut first = Box::pin(shutdown.run(work));
    tokio::select! {
        biased;
        result = &mut first => panic!("cleanup escaped its gate: {result:?}"),
        _ = entered.notified() => {},
    }
    drop(first);
    let mut second = Box::pin(shutdown.run(|| async { panic!("cleanup replayed") }));
    assert!(futures_util::poll!(&mut second).is_pending());
    release.add_permits(1);
    let (second, third) = tokio::join!(
        second,
        shutdown.run(|| async { panic!("cleanup replayed") })
    );
    assert_eq!(second, third);
    assert_eq!(second, Err(unavailable("synthetic owner")));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn release_results_retain_the_first_failure_and_later_failures() {
    let result = cleanup_results([
        Err(unavailable("first owner")),
        Ok(()),
        Err(unavailable("last owner")),
    ])
    .unwrap_err();
    let Failure::Unavailable(message) = result else {
        panic!("unexpected failure category")
    };
    assert!(message.starts_with("first owner"));
    assert!(message.contains("last owner"));
}
