use std::{
    future::{Future, poll_fn},
    pin::Pin,
    sync::{Arc, Mutex},
    task::Poll,
};
use tokio::sync::{Semaphore, mpsc};
use ycoding_core::session::run_coordinator::{
    Coordinator, Drain, DrainRequest, Error, InterruptReason, Outcome, RunFuture,
};
use ycoding_schema::session;

struct Gate {
    calls: Arc<Mutex<Vec<(session::Id, bool)>>>,
    started: mpsc::UnboundedSender<session::Id>,
    permits: Arc<Semaphore>,
}
impl Drain for Gate {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let calls = self.calls.clone();
        let started = self.started.clone();
        let permits = self.permits.clone();
        Box::pin(async move {
            calls
                .lock()
                .unwrap()
                .push((request.session_id.clone(), request.force));
            started.send(request.session_id).unwrap();
            permits.acquire().await.unwrap().forget();
            Ok(())
        })
    }
}

fn setup() -> (Coordinator, Arc<Gate>, mpsc::UnboundedReceiver<session::Id>) {
    let (started, receiver) = mpsc::unbounded_channel();
    let runner = Arc::new(Gate {
        calls: Arc::new(Mutex::new(Vec::new())),
        started,
        permits: Arc::new(Semaphore::new(0)),
    });
    (Coordinator::new(runner.clone()), runner, receiver)
}
fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}
async fn pending(future: Pin<&mut impl Future<Output = Outcome>>) {
    let mut future = future;
    poll_fn(|context| {
        assert!(future.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[test]
fn runtime_drop_discards_pending_wakes_and_releases_admitted_waiters() {
    const CHILD: &str = "YCODING_COORDINATOR_DROP_CHILD";
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    if std::env::var_os(CHILD).is_none() {
        runtime.block_on(async {
            let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "runtime_drop_discards_pending_wakes_and_releases_admitted_waiters",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let status =
                match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
                    Ok(status) => status.unwrap(),
                    Err(_) => {
                        child.kill().await.unwrap();
                        panic!("runtime teardown blocked with a pending wake");
                    }
                };
            assert!(
                status.success(),
                "coordinator teardown child failed: {status}"
            );
        });
        return;
    }
    drop(runtime);
    for polled in [false, true] {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let (coordinator, runner, mut started) = setup();
        let session = id();
        let mut joined = Box::pin(coordinator.run(&session));
        {
            let _entered = runtime.enter();
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(joined.as_mut().poll(&mut context).is_pending());
        }
        if polled {
            runtime.block_on(async { started.recv().await.unwrap() });
        }
        coordinator.wake(&session).unwrap();
        drop(runtime);
        assert!(coordinator.active().is_empty());
        assert_eq!(
            *runner.calls.lock().unwrap(),
            if polled { vec![(id(), true)] } else { vec![] }
        );
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(matches!(
            joined.as_mut().poll(&mut context),
            Poll::Ready(Err(Error::Panicked))
        ));
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let handle = runtime.handle().clone();
    drop(runtime);
    let _entered = handle.enter();
    let (coordinator, runner, _started) = setup();
    let session = id();
    coordinator.wake(&session).unwrap();
    assert!(coordinator.active().is_empty());
    let mut joined = Box::pin(coordinator.run(&session));
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    assert!(matches!(
        joined.as_mut().poll(&mut context),
        Poll::Ready(Err(Error::Panicked))
    ));
    let mut transition =
        Box::pin(coordinator.with_transition(&session, std::future::pending::<()>()));
    assert!(transition.as_mut().poll(&mut context).is_pending());
    coordinator.wake(&session).unwrap();
    drop(transition);
    assert!(coordinator.active().is_empty());
    assert!(runner.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn resume_admission_returns_before_drain_and_keeps_coordinator_ownership() {
    let (coordinator, runner, mut started) = setup();
    let session = id();
    tokio::time::timeout(
        std::time::Duration::from_secs(2),
        coordinator.request_resume(&session),
    )
    .await
    .unwrap()
    .unwrap();
    started.recv().await.unwrap();
    coordinator.request_resume(&session).await.unwrap();
    assert_eq!(coordinator.active(), vec![session.clone()]);
    assert_eq!(*runner.calls.lock().unwrap(), vec![(session.clone(), true)]);
    let mut joined = Box::pin(coordinator.run(&session));
    pending(joined.as_mut()).await;
    coordinator.shutdown().await.unwrap();
    assert!(matches!(
        joined.await,
        Err(Error::Interrupted(InterruptReason::Shutdown))
    ));
    assert!(coordinator.active().is_empty());
    assert!(matches!(
        coordinator.request_resume(&session).await,
        Err(Error::Closed)
    ));
}

#[tokio::test]
async fn resume_admission_waits_for_a_transition_without_losing_force() {
    let (coordinator, runner, mut started) = setup();
    let session = id();
    let mut transition =
        Box::pin(coordinator.with_transition(&session, std::future::pending::<()>()));
    poll_fn(|context| {
        assert!(transition.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    let mut admission = Box::pin(coordinator.request_resume(&session));
    pending(admission.as_mut()).await;
    assert!(runner.calls.lock().unwrap().is_empty());
    drop(transition);
    tokio::time::timeout(std::time::Duration::from_secs(2), admission)
        .await
        .unwrap()
        .unwrap();
    started.recv().await.unwrap();
    assert_eq!(*runner.calls.lock().unwrap(), vec![(session, true)]);
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn resume_admission_waits_for_interrupted_cleanup_but_not_the_next_drain() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(None),
        panic: false,
    }));
    let session = id();
    coordinator.wake(&session).unwrap();
    started.recv().await.unwrap();
    coordinator
        .request_interrupt(&session, InterruptReason::User)
        .unwrap();
    assert!(matches!(
        settled.recv().await.unwrap(),
        Err(Error::Interrupted(_))
    ));
    let mut admission = Box::pin(coordinator.request_resume(&session));
    pending(admission.as_mut()).await;
    release.add_permits(1);
    tokio::time::timeout(std::time::Duration::from_secs(2), admission)
        .await
        .unwrap()
        .unwrap();
    started.recv().await.unwrap();
    assert_eq!(
        *runner.calls.lock().unwrap(),
        vec![(session.clone(), false), (session, true)]
    );
    release.add_permits(1);
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn joins_concurrent_resumes_for_one_session_and_wake_started_execution() {
    let (coordinator, runner, mut started) = setup();
    let session = id();
    let mut first = Box::pin(coordinator.run(&session));
    pending(first.as_mut()).await;
    started.recv().await.unwrap();
    let mut second = Box::pin(coordinator.run(&session));
    pending(second.as_mut()).await;
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
    runner.permits.add_permits(1);
    first.await.unwrap();
    second.await.unwrap();
    assert!(coordinator.active().is_empty());
    coordinator.wake(&session).unwrap();
    started.recv().await.unwrap();
    let mut joined = Box::pin(coordinator.run(&session));
    pending(joined.as_mut()).await;
    runner.permits.add_permits(1);
    joined.await.unwrap();
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![true, false]
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn coalesces_active_wakes_into_one_advisory_redrain() {
    let (coordinator, runner, mut started) = setup();
    coordinator.wake(&id()).unwrap();
    started.recv().await.unwrap();
    for _ in 0..100 {
        coordinator.wake(&id()).unwrap();
    }
    runner.permits.add_permits(2);
    coordinator.await_idle(&id()).await;
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![false, false]
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn different_sessions_run_concurrently_and_idle_wait_never_starts_work() {
    let (coordinator, runner, mut started) = setup();
    coordinator.await_idle(&id()).await;
    assert!(runner.calls.lock().unwrap().is_empty());
    let other = session::Id::new("ses_two").unwrap();
    coordinator.wake(&id()).unwrap();
    coordinator.wake(&other).unwrap();
    started.recv().await.unwrap();
    started.recv().await.unwrap();
    assert_eq!(coordinator.active().len(), 2);
    runner.permits.add_permits(2);
    coordinator.await_idle(&id()).await;
    coordinator.await_idle(&other).await;
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn interruption_clears_the_doorbell_and_waits_for_settlement_while_idle_is_noop() {
    let (coordinator, runner, mut started) = setup();
    coordinator
        .interrupt(&id(), InterruptReason::User)
        .await
        .unwrap();
    coordinator.wake(&id()).unwrap();
    started.recv().await.unwrap();
    coordinator.wake(&id()).unwrap();
    coordinator
        .interrupt(&id(), InterruptReason::User)
        .await
        .unwrap();
    assert!(coordinator.active().is_empty());
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
    coordinator.shutdown().await.unwrap();
    assert!(matches!(coordinator.wake(&id()), Err(Error::Closed)));
}

#[tokio::test]
async fn transitions_serialize_and_forward_only_one_advisory_doorbell_after_last_release() {
    let (coordinator, runner, mut started) = setup();
    let session = id();
    let (release, gate) = tokio::sync::oneshot::channel();
    let (entered, entering) = tokio::sync::oneshot::channel();
    let transition_coordinator = coordinator.clone();
    let transition_id = session.clone();
    let transition = tokio::spawn(async move {
        transition_coordinator
            .with_transition(&transition_id, async {
                entered.send(()).unwrap();
                gate.await.unwrap();
            })
            .await
            .unwrap()
    });
    entering.await.unwrap();
    for _ in 0..10 {
        coordinator.wake(&session).unwrap();
    }
    coordinator.await_idle(&session).await;
    assert!(runner.calls.lock().unwrap().is_empty());
    let second_entered = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let second_flag = second_entered.clone();
    let mut second = Box::pin(coordinator.with_transition(&session, async move {
        second_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    }));
    poll_fn(|context| {
        assert!(second.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(!second_entered.load(std::sync::atomic::Ordering::SeqCst));
    release.send(()).unwrap();
    transition.await.unwrap();
    assert!(runner.calls.lock().unwrap().is_empty());
    second.await.unwrap();
    started.recv().await.unwrap();
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![false]
    );
    runner.permits.add_permits(1);
    coordinator.await_idle(&session).await;
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn cancelled_transition_releases_reservation_and_explicit_resume_waits() {
    let (coordinator, runner, mut started) = setup();
    let session = id();
    let mut transition =
        Box::pin(coordinator.with_transition(&session, std::future::pending::<()>()));
    poll_fn(|context| {
        assert!(transition.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    let mut resumed = Box::pin(coordinator.run(&session));
    pending(resumed.as_mut()).await;
    assert!(runner.calls.lock().unwrap().is_empty());
    drop(transition);
    pending(resumed.as_mut()).await;
    started.recv().await.unwrap();
    runner.permits.add_permits(1);
    resumed.await.unwrap();
    assert!(runner.calls.lock().unwrap()[0].1);
    coordinator.shutdown().await.unwrap();
}

struct Hooks {
    runner: Arc<Gate>,
    settling: mpsc::UnboundedSender<Outcome>,
    release: Arc<Semaphore>,
    failure: Mutex<Option<Outcome>>,
    panic: bool,
}

impl Drain for Hooks {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let future = self.runner.drain(request);
        let failure = self.failure.lock().unwrap().take();
        let panic = self.panic;
        Box::pin(async move {
            future.await?;
            assert!(!panic, "runner defect");
            failure.unwrap_or(Ok(()))
        })
    }

    fn settled(&self, _id: session::Id, outcome: Outcome) -> RunFuture {
        let settling = self.settling.clone();
        let release = self.release.clone();
        Box::pin(async move {
            settling.send(outcome).unwrap();
            release.acquire().await.unwrap().forget();
            Ok(())
        })
    }
}

#[tokio::test]
async fn late_interrupt_is_noop_after_terminal_settlement_starts() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(None),
        panic: false,
    }));
    coordinator.wake(&id()).unwrap();
    started.recv().await.unwrap();
    runner.permits.add_permits(1);
    assert!(settled.recv().await.unwrap().is_ok());
    let session = id();
    let mut interrupt = Box::pin(coordinator.interrupt(&session, InterruptReason::User));
    poll_fn(|context| {
        assert!(matches!(
            interrupt.as_mut().poll(context),
            Poll::Ready(Ok(()))
        ));
        Poll::Ready(())
    })
    .await;
    release.add_permits(1);
    coordinator.await_idle(&id()).await;
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn runner_defect_runs_settlement_before_releasing_waiters() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(None),
        panic: true,
    }));
    let session = id();
    let mut resumed = Box::pin(coordinator.run(&session));
    pending(resumed.as_mut()).await;
    started.recv().await.unwrap();
    runner.permits.add_permits(1);
    tokio::select! {
        outcome = settled.recv() => assert!(matches!(outcome, Some(Err(Error::Panicked)))),
        outcome = resumed.as_mut() => panic!("waiter bypassed settlement: {outcome:?}"),
    }
    pending(resumed.as_mut()).await;
    release.add_permits(1);
    assert!(matches!(resumed.await, Err(Error::Panicked)));
    assert!(coordinator.active().is_empty());
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn followup_wakes_share_one_busy_period_and_dropped_joiners_do_not_cancel_it() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(None),
        panic: false,
    }));
    let session = id();
    let mut resumed = Box::pin(coordinator.run(&session));
    pending(resumed.as_mut()).await;
    started.recv().await.unwrap();
    let mut joined = Box::pin(coordinator.run(&session));
    pending(joined.as_mut()).await;
    drop(joined);
    coordinator.wake(&session).unwrap();
    runner.permits.add_permits(1);
    started.recv().await.unwrap();
    coordinator.wake(&session).unwrap();
    runner.permits.add_permits(1);
    started.recv().await.unwrap();
    runner.permits.add_permits(1);
    assert!(settled.recv().await.unwrap().is_ok());
    pending(resumed.as_mut()).await;
    release.add_permits(1);
    resumed.await.unwrap();
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![true, false, false]
    );
    assert!(settled.try_recv().is_err());
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn failure_doorbells_register_successor_before_original_waiters_resolve() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(Some(Err(Error::Runner(
            ycoding_schema::session_error::Error {
                r#type: "provider.transport".into(),
                message: "Disconnected".into(),
            },
        )))),
        panic: false,
    }));
    let session = id();
    let mut resumed = Box::pin(coordinator.run(&session));
    pending(resumed.as_mut()).await;
    started.recv().await.unwrap();
    coordinator.wake(&session).unwrap();
    coordinator.wake(&session).unwrap();
    runner.permits.add_permits(1);
    assert!(matches!(
        settled.recv().await.unwrap(),
        Err(Error::Runner(_))
    ));
    release.add_permits(1);
    assert!(matches!(resumed.await, Err(Error::Runner(_))));
    assert_eq!(coordinator.active(), vec![session.clone()]);
    started.recv().await.unwrap();
    let mut idle = Box::pin(coordinator.await_idle(&session));
    poll_fn(|context| {
        assert!(idle.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    runner.permits.add_permits(1);
    assert!(settled.recv().await.unwrap().is_ok());
    release.add_permits(1);
    idle.await;
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![true, false]
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn resume_during_interruption_waits_for_cleanup_then_forces_new_work() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(None),
        panic: false,
    }));
    coordinator.wake(&id()).unwrap();
    started.recv().await.unwrap();
    coordinator
        .request_interrupt(&id(), InterruptReason::User)
        .unwrap();
    assert!(matches!(
        settled.recv().await.unwrap(),
        Err(Error::Interrupted(InterruptReason::User))
    ));
    let resumed_coordinator = coordinator.clone();
    let (waiting, waiter) = tokio::sync::oneshot::channel();
    let resumed = tokio::spawn(async move {
        let session = id();
        let mut resumed = Box::pin(resumed_coordinator.run(&session));
        pending(resumed.as_mut()).await;
        waiting.send(()).unwrap();
        resumed.await
    });
    waiter.await.unwrap();
    release.add_permits(1);
    started.recv().await.unwrap();
    runner.permits.add_permits(1);
    assert!(settled.recv().await.unwrap().is_ok());
    release.add_permits(1);
    resumed.await.unwrap().unwrap();
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![false, true]
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn transition_preserves_a_preinterrupt_doorbell_and_cleanup_wakes() {
    let (_, runner, mut started) = setup();
    let (settling, mut settled) = mpsc::unbounded_channel();
    let release = Arc::new(Semaphore::new(0));
    let coordinator = Coordinator::new(Arc::new(Hooks {
        runner: runner.clone(),
        settling,
        release: release.clone(),
        failure: Mutex::new(None),
        panic: false,
    }));
    coordinator.wake(&id()).unwrap();
    started.recv().await.unwrap();
    coordinator.wake(&id()).unwrap();
    let session = id();
    let mut transition =
        Box::pin(coordinator.with_transition(&session, std::future::pending::<()>()));
    poll_fn(|context| {
        assert!(transition.as_mut().poll(context).is_pending());
        Poll::Ready(())
    })
    .await;
    coordinator
        .request_interrupt(&session, InterruptReason::Superseded)
        .unwrap();
    assert!(matches!(
        settled.recv().await.unwrap(),
        Err(Error::Interrupted(InterruptReason::Superseded))
    ));
    coordinator.wake(&session).unwrap();
    release.add_permits(1);
    coordinator.await_idle(&session).await;
    assert_eq!(runner.calls.lock().unwrap().len(), 1);
    drop(transition);
    started.recv().await.unwrap();
    runner.permits.add_permits(1);
    assert!(settled.recv().await.unwrap().is_ok());
    release.add_permits(1);
    coordinator.await_idle(&session).await;
    assert_eq!(
        runner
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|(_, force)| *force)
            .collect::<Vec<_>>(),
        vec![false, false]
    );
    coordinator.shutdown().await.unwrap();
}

struct Chain {
    coordinator: Mutex<Option<Coordinator>>,
    released: mpsc::UnboundedSender<()>,
}

struct ChainGuard(mpsc::UnboundedSender<()>);
impl Drop for ChainGuard {
    fn drop(&mut self) {
        self.0.send(()).unwrap();
    }
}

impl Drain for Chain {
    fn drain(&self, request: DrainRequest) -> RunFuture {
        let coordinator = self.coordinator.lock().unwrap().as_ref().unwrap().clone();
        let released = self.released.clone();
        Box::pin(async move {
            let _guard = ChainGuard(released);
            async {
                coordinator.request_interrupt(&request.session_id, InterruptReason::User)?;
                std::future::pending::<Outcome>().await
            }
            .await
        })
    }
}

#[tokio::test]
async fn awaited_child_can_request_interruption_of_its_own_active_chain() {
    let (released, mut receiver) = mpsc::unbounded_channel();
    let chain = Arc::new(Chain {
        coordinator: Mutex::new(None),
        released,
    });
    let coordinator = Coordinator::new(chain.clone());
    *chain.coordinator.lock().unwrap() = Some(coordinator.clone());
    assert!(matches!(
        coordinator.run(&id()).await,
        Err(Error::Interrupted(InterruptReason::User))
    ));
    receiver.recv().await.unwrap();
    assert!(coordinator.active().is_empty());
    chain.coordinator.lock().unwrap().take();
    coordinator.shutdown().await.unwrap();
}
