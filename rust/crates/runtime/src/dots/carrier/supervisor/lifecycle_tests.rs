use super::*;
use crate::dots::carrier::{Clock, SystemClock};
use std::{
    sync::atomic::{AtomicUsize, Ordering},
    time::Instant,
};
use tokio::sync::{Notify, Semaphore};
use ycoding_core::ycoding_schema::LosslessString;

struct Resource {
    id: &'static str,
    entered: Arc<Notify>,
    release: Arc<Semaphore>,
    closes: Arc<AtomicUsize>,
    fail: bool,
    panic: bool,
}

impl Resources for Resource {
    fn initialize<'a>(
        &'a self,
        _: &'a LosslessString,
        _: Link,
    ) -> Borrowed<'a, Result<String, Rejection>> {
        Box::pin(async { Ok(self.id.into()) })
    }

    fn close(&self) -> Borrowed<'_, Result<(), ()>> {
        Box::pin(async move {
            self.closes.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_one();
            self.release.acquire().await.unwrap().forget();
            assert!(!self.panic, "synthetic resource panic");
            if self.fail { Err(()) } else { Ok(()) }
        })
    }
}

fn registry() -> Arc<Sessions> {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock(Instant::now()));
    Sessions::new(clock, DETACHED_TTL_MS, Diagnostics::new(Arc::new(|_| {})))
}

async fn attach(
    registry: &Arc<Sessions>,
    id: &'static str,
    fail: bool,
    panic: bool,
) -> (Connection, Arc<Resource>) {
    let resource = Arc::new(Resource {
        id,
        entered: Arc::new(Notify::new()),
        release: Arc::new(Semaphore::new(0)),
        closes: Arc::new(AtomicUsize::new(0)),
        fail,
        panic,
    });
    let held = resource.clone();
    let open: Opener = Arc::new(move || {
        let held: Arc<dyn Resources> = held.clone();
        Box::pin(async move { Ok(held) })
    });
    let connection = registry.connect(open);
    connection
        .initialize(&"synthetic".into(), Arc::new(()))
        .await
        .unwrap();
    (connection, resource)
}

#[tokio::test]
async fn cancelled_and_concurrent_shutdowns_await_one_close_and_retain_its_failure() {
    let registry = registry();
    let (_connection, resource) = attach(&registry, "first", true, false).await;
    let mut first = Box::pin(registry.shutdown());
    tokio::select! {
        biased;
        result = &mut first => panic!("shutdown escaped resource close: {result:?}"),
        _ = resource.entered.notified() => {},
    }
    drop(first);
    let mut second = Box::pin(registry.shutdown());
    assert!(futures_util::poll!(&mut second).is_pending());
    resource.release.add_permits(1);
    let (second, third) = tokio::join!(second, registry.shutdown());
    assert_eq!(second, third);
    assert_eq!(
        second.unwrap_err().failures,
        [CleanupFailure::ResourceClose]
    );
    assert_eq!(
        registry.shutdown().await.unwrap_err().failures,
        [CleanupFailure::ResourceClose]
    );
    assert_eq!(resource.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn successful_shutdown_waits_for_resource_close_before_settling() {
    let registry = registry();
    let (_connection, resource) = attach(&registry, "first", false, false).await;
    let mut shutdown = Box::pin(registry.shutdown());
    tokio::select! {
        biased;
        result = &mut shutdown => panic!("shutdown escaped resource close: {result:?}"),
        _ = resource.entered.notified() => {},
    }
    resource.release.add_permits(1);
    shutdown.await.unwrap();
    registry.shutdown().await.unwrap();
    assert_eq!(resource.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_panicking_close_reaches_shutdown_and_does_not_skip_another_close() {
    let registry = registry();
    let (_connection, resource) = attach(&registry, "first", false, true).await;
    let (_other, other) = attach(&registry, "second", false, false).await;
    resource.release.add_permits(1);
    other.release.add_permits(1);
    let result = registry.shutdown().await.unwrap_err();
    assert_eq!(result.failures, [CleanupFailure::ResourceJoin]);
    assert_eq!(registry.shutdown().await.unwrap_err(), result);
    assert_eq!(resource.closes.load(Ordering::SeqCst), 1);
    assert_eq!(other.closes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_run_join_failure_still_drains_its_sessions() {
    let sessions = registry();
    let (_connection, resource) = attach(&sessions, "first", true, false).await;
    resource.release.add_permits(1);
    let (cancel, _) = watch::channel(false);
    let task: JoinHandle<Result<(), CleanupError>> =
        tokio::spawn(async { panic!("synthetic run panic") });
    let mut control = Control {
        selected: None,
        run: Some(Run {
            cancel,
            task,
            sessions,
        }),
    };
    let result = control.halt().await.unwrap_err();
    assert_eq!(
        result.failures,
        [CleanupFailure::RunJoin, CleanupFailure::ResourceClose]
    );
    assert_eq!(resource.closes.load(Ordering::SeqCst), 1);
    assert!(control.run.is_none());
}

#[tokio::test]
async fn supervisor_shutdown_awaits_its_follower_and_retains_a_join_failure() {
    let (stop, mut stopped) = watch::channel(false);
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Semaphore::new(0));
    let (started, gate) = (entered.clone(), release.clone());
    let follower: JoinHandle<()> = tokio::spawn(async move {
        crate::dots::carrier::cancelled(&mut stopped).await;
        started.notify_one();
        gate.acquire().await.unwrap().forget();
        panic!("synthetic follower panic");
    });
    let completion: Boxed<Result<(), CleanupError>> = Box::pin(async move {
        follower.await.map_err(|_| CleanupError {
            failures: vec![CleanupFailure::FollowerJoin],
        })
    });
    let supervisor = Supervisor {
        subscription: Mutex::new(None),
        stop,
        completion: completion.shared(),
        connection: Arc::new(Mutex::new(super::ConnectionObservation::new())),
        configuration: Arc::new(|| Ok(ycoding_core::dots::native::Configuration::Disabled)),
    };
    let mut first = Box::pin(supervisor.shutdown());
    tokio::select! {
        biased;
        result = &mut first => panic!("shutdown escaped follower: {result:?}"),
        _ = entered.notified() => {},
    }
    drop(first);
    release.add_permits(1);
    let (first, second) = tokio::join!(supervisor.shutdown(), supervisor.shutdown());
    assert_eq!(first, second);
    assert_eq!(first.unwrap_err().failures, [CleanupFailure::FollowerJoin]);
}

#[tokio::test]
async fn cancelling_initialization_does_not_lose_resources_returned_by_an_opening_owner() {
    let registry = registry();
    let opened = Arc::new(Notify::new());
    let release_open = Arc::new(Semaphore::new(0));
    let resource = Arc::new(Resource {
        id: "opening",
        entered: Arc::new(Notify::new()),
        release: Arc::new(Semaphore::new(1)),
        closes: Arc::new(AtomicUsize::new(0)),
        fail: true,
        panic: false,
    });
    let (held, started, gate) = (resource.clone(), opened.clone(), release_open.clone());
    let open: Opener = Arc::new(move || {
        let (held, started, gate) = (held.clone(), started.clone(), gate.clone());
        Box::pin(async move {
            started.notify_one();
            gate.acquire().await.unwrap().forget();
            Ok(held as Arc<dyn Resources>)
        })
    });
    let connection = registry.connect(open);
    let name = LosslessString::from("synthetic");
    let mut initializing = Box::pin(connection.initialize(&name, Arc::new(())));
    tokio::select! {
        biased;
        result = &mut initializing => panic!("open escaped its gate: {result:?}"),
        _ = opened.notified() => {},
    }
    drop(initializing);
    let mut shutting_down = Box::pin(registry.shutdown());
    assert!(futures_util::poll!(&mut shutting_down).is_pending());
    assert_eq!(resource.closes.load(Ordering::SeqCst), 0);
    release_open.add_permits(1);
    assert_eq!(
        shutting_down.await.unwrap_err().failures,
        [CleanupFailure::ResourceClose]
    );
    assert_eq!(resource.closes.load(Ordering::SeqCst), 1);
}
