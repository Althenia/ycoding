use serde_json::{Map, Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, oneshot};
use ycoding_core::job::{
    BackgroundReason, BlockInput, BlockResult, Info, Jobs, Run, StartInput, Status,
};
use ycoding_schema::session;

const LIMIT: Duration = Duration::from_secs(5);

fn session(id: &str) -> session::Id {
    session::Id::new(id).unwrap()
}

fn input(kind: &str, run: Run) -> StartInput {
    StartInput {
        id: None,
        kind: kind.into(),
        title: None,
        metadata: None,
        run,
    }
}

fn gated(output: &'static str) -> (Arc<Notify>, Run) {
    let gate = Arc::new(Notify::new());
    let waiting = gate.clone();
    (
        gate,
        Box::pin(async move {
            waiting.notified().await;
            Ok(output.into())
        }),
    )
}

fn block(id: &str, session_id: &str, background_after: Option<Duration>) -> BlockInput {
    BlockInput {
        id: id.into(),
        session_id: session(session_id),
        background_after,
    }
}

fn metadata(value: Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(LIMIT, future).await.unwrap()
}

async fn completed(jobs: &Jobs, id: &str, output: &str) {
    let result = within(jobs.wait(id, None)).await;
    assert!(!result.timed_out);
    let info = result.info.unwrap();
    assert_eq!(info.status, Status::Completed);
    assert_eq!(info.output.as_deref(), Some(output));
}

#[tokio::test]
async fn background_shell_stays_outstanding_until_its_notice_is_admitted() {
    let jobs = Jobs::new();
    let id = session("ses_shell_notice");
    let (gate, run) = gated("done");
    let job = jobs
        .start(StartInput {
            metadata: metadata(json!({"sessionID": "ses_shell_notice"})),
            ..input("shell", run)
        })
        .unwrap();
    assert_eq!(jobs.outstanding_sessions(), [id.clone()].into());
    jobs.background(&job.id);
    gate.notify_one();
    within(jobs.wait(&job.id, None)).await;
    assert_eq!(jobs.outstanding_sessions(), [id].into());
    jobs.notice_admitted(&job.id);
    assert!(jobs.outstanding_sessions().is_empty());
}

#[tokio::test]
async fn outstanding_sessions_ignore_non_shell_jobs_and_non_session_identities() {
    let jobs = Jobs::new();
    let (_keep_a, run_a) = gated("a");
    let (_keep_b, run_b) = gated("b");
    let (_keep_c, run_c) = gated("c");
    jobs.start(StartInput {
        metadata: metadata(json!({"sessionID": "ses_other_kind"})),
        ..input("test", run_a)
    })
    .unwrap();
    jobs.start(StartInput {
        metadata: metadata(json!({"sessionID": "not_a_session"})),
        ..input("shell", run_b)
    })
    .unwrap();
    jobs.start(input("shell", run_c)).unwrap();
    assert!(jobs.outstanding_sessions().is_empty());
}

#[tokio::test]
async fn tracks_process_local_work_through_explicit_observation() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs
        .start(StartInput {
            metadata: metadata(json!({"durable": false})),
            ..input("test", run)
        })
        .unwrap();
    assert_eq!(job.kind, "test");
    assert_eq!(job.status, Status::Running);
    assert_eq!(job.metadata, metadata(json!({"durable": false})));
    assert!(job.id.starts_with("job_"));
    let pending = jobs.wait(&job.id, Some(Duration::ZERO)).await;
    assert!(pending.timed_out);
    assert_eq!(pending.info.unwrap().status, Status::Running);
    gate.notify_one();
    let result = within(jobs.wait(&job.id, None)).await;
    assert!(!result.timed_out);
    let info = result.info.unwrap();
    assert_eq!(info.status, Status::Completed);
    assert_eq!(info.output.as_deref(), Some("done"));
    assert!(info.completed_at.unwrap() >= info.started_at);
}

#[tokio::test]
async fn wait_with_a_positive_timeout_reports_timeout_then_completion() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let started = Instant::now();
    let pending = jobs.wait(&job.id, Some(Duration::from_millis(100))).await;
    assert!(pending.timed_out);
    assert!(started.elapsed() >= Duration::from_millis(100));
    gate.notify_one();
    let settled = within(jobs.wait(&job.id, Some(LIMIT))).await;
    assert!(!settled.timed_out);
    assert_eq!(settled.info.unwrap().status, Status::Completed);
    assert_eq!(jobs.wait("job_missing", None).await.info, None);
}

#[tokio::test]
async fn publishes_jobs_before_starting_immediately_settling_work() {
    let jobs = Jobs::new();
    for index in 0..100 {
        let id = format!("job_immediate_start_{index}");
        let observer = jobs.clone();
        let observed = id.clone();
        let job = jobs
            .start(StartInput {
                id: Some(id),
                ..input(
                    "test",
                    Box::pin(async move {
                        match observer.get(&observed).map(|info| info.status) {
                            Some(Status::Running) => Ok(format!("done-{index}")),
                            _ => Err("job started before publish".into()),
                        }
                    }),
                )
            })
            .unwrap();
        completed(&jobs, &job.id, &format!("done-{index}")).await;
    }
}

#[tokio::test]
async fn block_returns_finished_when_completion_wins() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_parent", None);
        async move { jobs.block(request).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    gate.notify_one();
    let BlockResult::Finished(info) = within(waiting).await.unwrap().unwrap() else {
        panic!("expected finished");
    };
    assert_eq!(info.status, Status::Completed);
    assert_eq!(info.output.as_deref(), Some("done"));
    assert_eq!(jobs.background(&job.id), None);
}

#[tokio::test]
async fn block_returns_backgrounded_when_background_wins() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_parent", None);
        async move { jobs.block(request).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let backgrounded = jobs.background(&job.id).unwrap();
    assert_eq!(backgrounded.id, job.id);
    assert_eq!(backgrounded.status, Status::Running);
    let BlockResult::Backgrounded { info, reason } = within(waiting).await.unwrap().unwrap() else {
        panic!("expected backgrounded");
    };
    assert_eq!((info.id, info.status), (job.id.clone(), Status::Running));
    assert_eq!(reason, BackgroundReason::Request);
    gate.notify_one();
    completed(&jobs, &job.id, "done").await;
}

#[tokio::test]
async fn block_keeps_a_foreground_pending_until_its_background_deadline() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let deadline = Duration::from_millis(400);
    let started = Instant::now();
    let mut waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_deadline", Some(deadline));
        async move { jobs.block(request).await }
    });
    assert!(
        tokio::time::timeout(Duration::from_millis(200), &mut waiting)
            .await
            .is_err()
    );
    let BlockResult::Backgrounded { info, reason } = within(waiting).await.unwrap().unwrap() else {
        panic!("expected backgrounded");
    };
    assert!(started.elapsed() >= deadline);
    assert_eq!(reason, BackgroundReason::Deadline);
    assert_eq!(
        (info.id.as_str(), info.status),
        (job.id.as_str(), Status::Running)
    );
    assert_eq!(jobs.get(&job.id).unwrap().status, Status::Running);
    gate.notify_one();
    completed(&jobs, &job.id, "done").await;
}

#[tokio::test]
async fn block_cancels_the_background_deadline_when_completion_wins() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_completion", Some(Duration::from_millis(300)));
        async move { jobs.block(request).await }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    gate.notify_one();
    let BlockResult::Finished(info) = within(waiting).await.unwrap().unwrap() else {
        panic!("expected finished");
    };
    assert_eq!(info.status, Status::Completed);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(jobs.background(&job.id), None);
}

#[tokio::test]
async fn block_serializes_completion_racing_the_deadline_to_one_result() {
    let jobs = Jobs::new();
    let job = jobs
        .start(input(
            "test",
            Box::pin(async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                Ok("done".into())
            }),
        ))
        .unwrap();
    let result = within(jobs.block(block(&job.id, "ses_race", Some(Duration::from_millis(200)))))
        .await
        .unwrap();
    match result {
        BlockResult::Finished(info) => assert_eq!(info.status, Status::Completed),
        BlockResult::Backgrounded { reason, .. } => assert_eq!(reason, BackgroundReason::Deadline),
    }
    completed(&jobs, &job.id, "done").await;
}

#[tokio::test]
async fn interrupting_a_block_cancels_its_pending_deadline() {
    let jobs = Jobs::new();
    let (gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_interrupted", Some(Duration::from_millis(200)));
        async move { jobs.block(request).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    waiting.abort();
    assert!(waiting.await.unwrap_err().is_cancelled());
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(jobs.get(&job.id).unwrap().status, Status::Running);
    let backgrounded = jobs.background(&job.id).unwrap();
    assert_eq!(
        (backgrounded.id, backgrounded.status),
        (job.id.clone(), Status::Running)
    );
    assert!(
        jobs.background_all(&session("ses_interrupted"), None)
            .is_empty()
    );
    gate.notify_one();
}

#[tokio::test]
async fn interrupting_a_block_releases_its_session_hold() {
    let jobs = Jobs::new();
    let (_gate, run) = gated("done");
    let job = jobs.start(input("test", run)).unwrap();
    let waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_released", None);
        async move { jobs.block(request).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    waiting.abort();
    let _ = waiting.await;
    assert!(
        jobs.background_all(&session("ses_released"), None)
            .is_empty()
    );
    assert_eq!(jobs.get(&job.id).unwrap().status, Status::Running);
}

#[tokio::test]
async fn background_all_backgrounds_only_jobs_blocking_the_session() {
    let jobs = Jobs::new();
    let parent = session("ses_parent");
    let (gate, _) = gated("unused");
    let shared = |output: &'static str| -> Run {
        let waiting = gate.clone();
        Box::pin(async move {
            waiting.notified().await;
            Ok(output.into())
        })
    };
    let first = jobs
        .start(StartInput {
            id: Some("job_first".into()),
            ..input("test", shared("first"))
        })
        .unwrap();
    let second = jobs
        .start(StartInput {
            id: Some("job_second".into()),
            ..input("test", shared("second"))
        })
        .unwrap();
    let third = jobs
        .start(StartInput {
            id: Some("job_third".into()),
            ..input("other", shared("third"))
        })
        .unwrap();
    let spawn_block = |id: &str, session_id: &str| {
        let jobs = jobs.clone();
        let request = block(id, session_id, None);
        tokio::spawn(async move { jobs.block(request).await })
    };
    let first_wait = spawn_block(&first.id, "ses_parent");
    let second_wait = spawn_block(&second.id, "ses_other");
    let third_wait = spawn_block(&third.id, "ses_parent");
    tokio::time::sleep(Duration::from_millis(100)).await;

    let backgrounded = jobs.background_all(&parent, Some("test"));
    assert_eq!(
        backgrounded
            .iter()
            .map(|info| info.id.as_str())
            .collect::<Vec<_>>(),
        ["job_first"]
    );
    let BlockResult::Backgrounded { info, reason } = within(first_wait).await.unwrap().unwrap()
    else {
        panic!("expected backgrounded");
    };
    assert_eq!(
        (info.id.as_str(), reason),
        ("job_first", BackgroundReason::Request)
    );

    gate.notify_waiters();
    let BlockResult::Finished(second_info) = within(second_wait).await.unwrap().unwrap() else {
        panic!("expected finished");
    };
    assert_eq!(second_info.id, "job_second");
    let BlockResult::Finished(third_info) = within(third_wait).await.unwrap().unwrap() else {
        panic!("expected finished");
    };
    assert_eq!(third_info.id, "job_third");
}

#[tokio::test]
async fn closing_the_registry_interrupts_live_work_without_settling_it() {
    let jobs = Jobs::new();
    let (interrupted, signalled) = oneshot::channel();
    struct Dropped(Option<oneshot::Sender<()>>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let job = jobs
        .start(input(
            "test",
            Box::pin(async move {
                let _guard = Dropped(Some(interrupted));
                std::future::pending::<Result<String, String>>().await
            }),
        ))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    jobs.close();
    within(signalled).await.unwrap();
    assert_eq!(jobs.get(&job.id).unwrap().status, Status::Running);
}

#[tokio::test]
async fn dropping_the_registry_interrupts_live_work() {
    let jobs = Jobs::new();
    let flag = Arc::new(AtomicBool::new(false));
    let (interrupted, signalled) = oneshot::channel();
    struct Guard(Arc<AtomicBool>, Option<oneshot::Sender<()>>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
            if let Some(sender) = self.1.take() {
                let _ = sender.send(());
            }
        }
    }
    let guard = Guard(flag.clone(), Some(interrupted));
    jobs.start(input(
        "test",
        Box::pin(async move {
            let _guard = guard;
            std::future::pending::<Result<String, String>>().await
        }),
    ))
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(jobs);
    within(signalled).await.unwrap();
    assert!(flag.load(Ordering::SeqCst));
}

#[tokio::test]
async fn cancel_settles_cancelled_and_stops_the_work() {
    let jobs = Jobs::new();
    let (interrupted, signalled) = oneshot::channel::<()>();
    struct Guard(Option<oneshot::Sender<()>>);
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    let job = jobs
        .start(input(
            "test",
            Box::pin(async move {
                let _guard = Guard(Some(interrupted));
                std::future::pending::<Result<String, String>>().await
            }),
        ))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let waiting = tokio::spawn({
        let jobs = jobs.clone();
        let request = block(&job.id, "ses_cancel", None);
        async move { jobs.block(request).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let cancelled = within(jobs.cancel(&job.id)).await.unwrap();
    assert_eq!(cancelled.status, Status::Cancelled);
    assert!(cancelled.completed_at.is_some());
    within(signalled).await.unwrap();
    let BlockResult::Finished(info) = within(waiting).await.unwrap().unwrap() else {
        panic!("expected finished");
    };
    assert_eq!(info.status, Status::Cancelled);
    let waited = within(jobs.wait(&job.id, None)).await.info.unwrap();
    assert_eq!(waited.status, Status::Cancelled);
    assert_eq!(
        jobs.cancel(&job.id).await.unwrap().status,
        Status::Cancelled
    );
    assert_eq!(jobs.cancel("job_missing").await, None);
}

#[tokio::test]
async fn a_failed_run_settles_error_with_its_message() {
    let jobs = Jobs::new();
    let job = jobs
        .start(input("test", Box::pin(async { Err("boom".into()) })))
        .unwrap();
    let info = within(jobs.wait(&job.id, None)).await.info.unwrap();
    assert_eq!(info.status, Status::Error);
    assert_eq!(info.error.as_deref(), Some("boom"));
    assert_eq!(info.output, None);
}

#[tokio::test]
async fn a_panicking_run_settles_error_instead_of_staying_running() {
    let jobs = Jobs::new();
    let job = jobs
        .start(input(
            "test",
            Box::pin(async {
                if true {
                    panic!("explode");
                }
                Ok(String::new())
            }),
        ))
        .unwrap();
    let info = within(jobs.wait(&job.id, None)).await.info.unwrap();
    assert_eq!(info.status, Status::Error);
    assert!(info.error.is_some());
}

#[tokio::test]
async fn starting_a_running_id_returns_the_existing_job_and_a_finished_id_restarts() {
    let jobs = Jobs::new();
    let (gate, run) = gated("first");
    let job = jobs
        .start(StartInput {
            id: Some("job_fixed".into()),
            title: Some("first".into()),
            ..input("test", run)
        })
        .unwrap();
    let (_other, second_run) = gated("second");
    let again = jobs
        .start(StartInput {
            id: Some("job_fixed".into()),
            title: Some("second".into()),
            ..input("test", second_run)
        })
        .unwrap();
    assert_eq!(again.title.as_deref(), Some("first"));
    assert_eq!(again.started_at, job.started_at);
    assert_eq!(jobs.list().len(), 1);
    gate.notify_one();
    completed(&jobs, "job_fixed", "first").await;
    let restarted = jobs
        .start(StartInput {
            id: Some("job_fixed".into()),
            ..input("test", Box::pin(async { Ok("second".into()) }))
        })
        .unwrap();
    assert_eq!(restarted.status, Status::Running);
    completed(&jobs, "job_fixed", "second").await;
}

#[tokio::test]
async fn generated_ids_are_unique_ascending_and_list_follows_start_order() {
    let jobs = Jobs::new();
    let ids = (0..5)
        .map(|_| {
            jobs.start(input("test", Box::pin(async { Ok(String::new()) })))
                .unwrap()
                .id
        })
        .collect::<Vec<_>>();
    assert!(ids.iter().all(|id| id.starts_with("job_")));
    assert!(ids.windows(2).all(|pair| pair[0] < pair[1]));
    assert_eq!(
        jobs.list()
            .into_iter()
            .map(|info: Info| info.id)
            .collect::<Vec<_>>(),
        ids
    );
}

#[tokio::test]
async fn block_and_background_handle_missing_and_settled_jobs() {
    let jobs = Jobs::new();
    assert_eq!(
        jobs.block(block("job_missing", "ses_parent", None)).await,
        None
    );
    assert_eq!(jobs.background("job_missing"), None);
    let finished = jobs
        .start(input("test", Box::pin(async { Ok("x".into()) })))
        .unwrap();
    completed(&jobs, &finished.id, "x").await;
    let BlockResult::Finished(info) = jobs
        .block(block(&finished.id, "ses_parent", None))
        .await
        .unwrap()
    else {
        panic!("expected finished");
    };
    assert_eq!(info.status, Status::Completed);
    let (_gate, run) = gated("y");
    let running = jobs.start(input("test", run)).unwrap();
    jobs.background(&running.id).unwrap();
    let BlockResult::Backgrounded { reason, .. } = jobs
        .block(block(&running.id, "ses_parent", None))
        .await
        .unwrap()
    else {
        panic!("expected backgrounded");
    };
    assert_eq!(reason, BackgroundReason::Request);
}

#[tokio::test]
async fn settled_background_shell_job_owes_a_notice_when_backgrounded_again() {
    let jobs = Jobs::new();
    let job = jobs
        .start(StartInput {
            metadata: metadata(json!({"sessionID": "ses_late"})),
            ..input("shell", Box::pin(async { Ok("done".into()) }))
        })
        .unwrap();
    within(jobs.wait(&job.id, None)).await;
    assert!(jobs.outstanding_sessions().is_empty());
    assert_eq!(jobs.background(&job.id).unwrap().status, Status::Completed);
    assert_eq!(jobs.outstanding_sessions(), [session("ses_late")].into());
    jobs.notice_admitted(&job.id);
    assert!(jobs.outstanding_sessions().is_empty());
}
