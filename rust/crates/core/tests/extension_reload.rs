use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
};
use ycoding_core::extension::{Error, reload::Reloader, v5::TransformStage};

struct Attempt {
    stage: TransformStage,
    finish: oneshot::Sender<Result<(), Error>>,
    dropped: oneshot::Receiver<()>,
}

struct Dropped(Option<oneshot::Sender<()>>);

impl Drop for Dropped {
    fn drop(&mut self) {
        if let Some(send) = self.0.take() {
            let _ = send.send(());
        }
    }
}

struct Harness {
    reload: Reloader,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    attempts: mpsc::UnboundedReceiver<Attempt>,
}

impl Harness {
    fn new(debounce: Duration) -> Self {
        let (stop, stopped) = watch::channel(false);
        let (send, attempts) = mpsc::unbounded_channel();
        let (reload, tasks) = Reloader::start(
            debounce,
            stopped,
            Arc::new(move |stage| {
                let send = send.clone();
                Box::pin(async move {
                    let (finish, result) = oneshot::channel();
                    let (drop_send, dropped) = oneshot::channel();
                    let _guard = Dropped(Some(drop_send));
                    send.send(Attempt {
                        stage,
                        finish,
                        dropped,
                    })
                    .unwrap();
                    result.await.unwrap_or(Err(Error::Stopped))
                }) as Pin<Box<dyn Future<Output = Result<(), Error>> + Send>>
            }),
        );
        Self {
            reload,
            stop,
            tasks,
            attempts,
        }
    }

    async fn request(&self, stage: TransformStage) -> JoinHandle<Result<(), Error>> {
        let reload = self.reload.clone();
        let (send, admitted) = oneshot::channel();
        let task = tokio::spawn(async move {
            let pending = reload.request(stage);
            tokio::pin!(pending);
            let mut send = Some(send);
            std::future::poll_fn(|context| {
                let result = pending.as_mut().poll(context);
                if let Some(send) = send.take() {
                    let _ = send.send(());
                }
                result
            })
            .await
        });
        admitted.await.unwrap();
        task
    }

    async fn next(&mut self) -> Attempt {
        tokio::time::timeout(Duration::from_secs(5), self.attempts.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn close(self) {
        self.stop.send_replace(true);
        for task in self.tasks {
            tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(
            self.reload.request(TransformStage::Agents).await,
            Err(Error::Stopped)
        );
    }
}

#[tokio::test]
async fn reload_requests_inside_the_debounce_window_share_one_rebuild() {
    let mut harness = Harness::new(Duration::from_millis(500));
    let first = harness.request(TransformStage::Agents).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), harness.attempts.recv())
            .await
            .is_err()
    );
    let second = harness.request(TransformStage::Agents).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), harness.attempts.recv())
            .await
            .is_err()
    );
    let last_requested = tokio::time::Instant::now();
    let third = harness.request(TransformStage::Agents).await;
    let attempt = harness.next().await;
    let elapsed = last_requested.elapsed();
    let stage = attempt.stage;
    let waiting = !first.is_finished() && !second.is_finished() && !third.is_finished();
    attempt.finish.send(Ok(())).unwrap();
    let results = [
        first.await.unwrap(),
        second.await.unwrap(),
        third.await.unwrap(),
    ];
    let extra = harness.attempts.try_recv().is_ok();
    harness.close().await;
    assert!(elapsed >= Duration::from_millis(500));
    assert_eq!(stage, TransformStage::Agents);
    assert!(waiting);
    assert_eq!(results, [Ok(()), Ok(()), Ok(())]);
    assert!(!extra);
}

#[tokio::test]
async fn reload_arriving_during_a_rebuild_schedules_one_more_rebuild() {
    let mut harness = Harness::new(Duration::ZERO);
    let first = harness.request(TransformStage::Agents).await;
    let initial = harness.next().await;
    let second = harness.request(TransformStage::Agents).await;
    let third = harness.request(TransformStage::Agents).await;
    let commands = harness.request(TransformStage::Commands).await;
    let independent = harness.next().await;
    assert_eq!(independent.stage, TransformStage::Commands);
    independent.finish.send(Ok(())).unwrap();
    let command_result = commands.await.unwrap();
    let agent_waiters_pending =
        !first.is_finished() && !second.is_finished() && !third.is_finished();
    initial.finish.send(Ok(())).unwrap();
    let first_result = first.await.unwrap();
    let again = harness.next().await;
    let pending_after_first = !second.is_finished() && !third.is_finished();
    let stage = again.stage;
    again.finish.send(Ok(())).unwrap();
    let results = [second.await.unwrap(), third.await.unwrap()];
    let extra = harness.attempts.try_recv().is_ok();
    harness.close().await;
    assert_eq!(command_result, Ok(()));
    assert!(agent_waiters_pending);
    assert_eq!(first_result, Ok(()));
    assert!(pending_after_first);
    assert_eq!(stage, TransformStage::Agents);
    assert_eq!(results, [Ok(()), Ok(())]);
    assert!(!extra);
}

#[tokio::test]
async fn failed_rebuild_rejects_its_waiters_and_allows_a_later_request() {
    let mut harness = Harness::new(Duration::from_millis(10));
    let first = harness.request(TransformStage::Agents).await;
    let second = harness.request(TransformStage::Agents).await;
    harness
        .next()
        .await
        .finish
        .send(Err(Error::ExecutionFailed))
        .unwrap();
    let failed = [first.await.unwrap(), second.await.unwrap()];
    let retry = harness.request(TransformStage::Agents).await;
    harness.next().await.finish.send(Ok(())).unwrap();
    let recovered = retry.await.unwrap();
    harness.close().await;
    assert_eq!(
        failed,
        [Err(Error::ExecutionFailed), Err(Error::ExecutionFailed)]
    );
    assert_eq!(recovered, Ok(()));
}

#[tokio::test]
async fn stop_settles_pending_and_in_flight_reloads_and_joins_workers() {
    let mut waiting = Harness::new(Duration::from_secs(3600));
    let pending = waiting.request(TransformStage::Agents).await;
    waiting.stop.send_replace(true);
    let delayed = pending.await.unwrap();
    let rebuilt_while_delayed = waiting.attempts.try_recv().is_ok();
    waiting.close().await;

    let mut active = Harness::new(Duration::ZERO);
    let pending = active.request(TransformStage::Agents).await;
    let attempt = active.next().await;
    active.stop.send_replace(true);
    let result = pending.await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), attempt.dropped)
        .await
        .unwrap()
        .unwrap();
    assert!(attempt.finish.send(Ok(())).is_err());
    active.close().await;
    assert_eq!(delayed, Err(Error::Stopped));
    assert!(!rebuilt_while_delayed);
    assert_eq!(result, Err(Error::Stopped));
}

#[tokio::test]
async fn dropped_reload_waiter_does_not_cancel_the_rebuild() {
    let mut harness = Harness::new(Duration::from_millis(10));
    let abandoned = harness.request(TransformStage::Agents).await;
    let retained = harness.request(TransformStage::Agents).await;
    let attempt = harness.next().await;
    abandoned.abort();
    assert!(abandoned.await.unwrap_err().is_cancelled());
    attempt.finish.send(Ok(())).unwrap();
    let result = retained.await.unwrap();
    let extra = harness.attempts.try_recv().is_ok();
    harness.close().await;
    assert_eq!(result, Ok(()));
    assert!(!extra);
}

#[tokio::test]
async fn all_five_domain_stages_reload_and_non_domain_stages_are_rejected() {
    let mut harness = Harness::new(Duration::ZERO);
    for stage in [
        TransformStage::Agents,
        TransformStage::Commands,
        TransformStage::References,
        TransformStage::Skills,
        TransformStage::Catalog,
    ] {
        let requested = harness.request(stage).await;
        let attempt = harness.next().await;
        assert_eq!(attempt.stage, stage);
        attempt.finish.send(Ok(())).unwrap();
        assert_eq!(requested.await.unwrap(), Ok(()));
    }
    for stage in [
        TransformStage::SessionContext,
        TransformStage::ToolBefore,
        TransformStage::ToolAfter,
        TransformStage::ToolDefinitions,
    ] {
        assert_eq!(
            harness.reload.request(stage).await,
            Err(Error::Unauthorized)
        );
    }
    assert!(harness.attempts.try_recv().is_err());
    harness.close().await;
}
