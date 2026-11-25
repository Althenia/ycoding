use super::*;
use crate::dots::carrier::test_support;
use std::task::{Context, Waker};
use tokio::sync::{mpsc, oneshot};

struct Reject;

impl Acceptor for Reject {
    fn accept(&self, _: &str, _: Vec<u8>, _: Authorize) -> Boxed<Result<Accepted, ()>> {
        Box::pin(async { Err(()) })
    }
}

fn carrier() -> Carrier {
    Carrier::new(Settings {
        acceptor: Arc::new(Reject),
        authorize: Arc::new(|_, _, _| Box::pin(async { Ok(()) })),
        output: Arc::new(|_| Ok(())),
        clock: Arc::new(test_support::clock().0),
        on_channel: Arc::new(|_| Box::pin(async {})),
        max_stream_queued_bytes: DEFAULT_MAX_STREAM_QUEUED_BYTES,
        max_carrier_inbound_bytes: DEFAULT_MAX_CARRIER_INBOUND_BYTES,
    })
}

fn pending(future: Pin<&mut impl Future>) {
    assert!(
        future
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
}

#[tokio::test]
async fn close_success_is_repeatable_and_retires_admission() {
    let carrier = carrier();
    assert_eq!(carrier.close().await, Ok(()));
    carrier.handle(&wire::encode(&Frame::new(
        "synthetic",
        Body::Handshake { payload: vec![1] },
    )));
    assert_eq!(carrier.close().await, Ok(()));
    assert!(locked(&carrier.inner.tasks).tasks.is_empty());
    assert!(locked(&carrier.inner.queues).is_empty());
}

#[tokio::test]
async fn cancelled_close_keeps_all_tasks_and_prior_errors_for_concurrent_callers() {
    let carrier = carrier();
    let (release, wait) = oneshot::channel();
    let (done, completed) = oneshot::channel();
    locked(&carrier.inner.tasks).spawn(Worker::Queue, async { panic!("synthetic private panic") });
    locked(&carrier.inner.tasks).spawn(Worker::Channel, async move {
        wait.await.unwrap();
        done.send(()).unwrap();
    });
    let mut close = Box::pin(carrier.close());
    std::future::poll_fn(|cx| {
        assert!(close.as_mut().poll(cx).is_pending());
        if locked(&carrier.inner.tasks).failures.is_empty() {
            std::task::Poll::Pending
        } else {
            std::task::Poll::Ready(())
        }
    })
    .await;
    drop(close);
    release.send(()).unwrap();
    let (first, second) = tokio::join!(carrier.close(), carrier.close());
    completed.await.unwrap();
    assert_eq!(first, second);
    let error = first.unwrap_err();
    assert_eq!(
        error.failures(),
        &[CloseFailure {
            task: 0,
            worker: Worker::Queue,
            kind: JoinFailure::Panic
        },]
    );
    assert!(!format!("{error:?} {error}").contains("synthetic"));
    assert_eq!(carrier.close().await, Err(error));
}

#[tokio::test]
async fn close_preserves_every_join_failure_in_admission_order() {
    let carrier = carrier();
    let (release, wait) = oneshot::channel();
    locked(&carrier.inner.tasks).spawn(Worker::Queue, async move {
        wait.await.unwrap();
        panic!("synthetic first panic")
    });
    locked(&carrier.inner.tasks).spawn(Worker::Channel, async { panic!("synthetic second panic") });
    release.send(()).unwrap();
    let error = carrier.close().await.unwrap_err();
    assert_eq!(
        error.failures(),
        &[
            CloseFailure {
                task: 0,
                worker: Worker::Queue,
                kind: JoinFailure::Panic
            },
            CloseFailure {
                task: 1,
                worker: Worker::Channel,
                kind: JoinFailure::Panic
            },
        ]
    );
}

#[tokio::test]
async fn unexpected_worker_cancellation_is_an_attributed_failure() {
    let carrier = carrier();
    locked(&carrier.inner.tasks).spawn(Worker::Channel, std::future::pending());
    locked(&carrier.inner.tasks).tasks.abort_all();
    let error = carrier.close().await.unwrap_err();
    assert_eq!(
        error.failures(),
        &[CloseFailure {
            task: 0,
            worker: Worker::Channel,
            kind: JoinFailure::Cancelled
        },]
    );
}

struct Identity;

impl Cipher for Identity {
    fn encrypt(&self, bytes: &[u8]) -> Result<Vec<u8>, ()> {
        Ok(bytes.to_vec())
    }
    fn decrypt(&self, bytes: &[u8]) -> Result<Vec<u8>, ()> {
        Ok(bytes.to_vec())
    }
}

#[tokio::test]
async fn close_clears_queues_and_signals_streams_before_waiting_for_workers() {
    let carrier = carrier();
    let (closed, _) = watch::channel(false);
    let stream = Arc::new(Stream {
        instance: 1,
        cipher: Arc::new(Identity),
        harness_key_sha256: "a".repeat(64),
        closed,
        inbound: Mutex::default(),
        queue: Mutex::new(Queue {
            messages: VecDeque::from([vec![1]]),
            bytes: 1,
        }),
        ready: Notify::new(),
        outbound_seq: tokio::sync::Mutex::new(0),
    });
    carrier
        .inner
        .state()
        .streams
        .insert("synthetic".into(), stream.clone());
    let channel = Channel {
        stream_id: "synthetic".into(),
        stream: stream.clone(),
        inner: carrier.inner.clone(),
    };
    locked(&carrier.inner.queues).insert(
        "synthetic".into(),
        VecDeque::from([Frame::new(
            "synthetic",
            Body::Handshake { payload: vec![1] },
        )]),
    );
    let (release, wait) = oneshot::channel();
    locked(&carrier.inner.tasks).spawn(Worker::Channel, async move { wait.await.unwrap() });
    let mut close = Box::pin(carrier.close());
    pending(close.as_mut());
    assert!(*channel.closed().borrow());
    assert_eq!(channel.next().await, None);
    assert_eq!(channel.send(b"synthetic").await, Err(Closed));
    assert!(carrier.inner.state().streams.is_empty());
    assert!(locked(&carrier.inner.queues).is_empty());
    release.send(()).unwrap();
    assert_eq!(close.await, Ok(()));
}

struct Panicking(mpsc::UnboundedSender<()>);

impl Acceptor for Panicking {
    fn accept(&self, _: &str, _: Vec<u8>, _: Authorize) -> Boxed<Result<Accepted, ()>> {
        let entered = self.0.clone();
        Box::pin(async move {
            entered.send(()).unwrap();
            panic!("synthetic handshake panic")
        })
    }
}

#[tokio::test]
async fn a_real_handshake_worker_panic_reaches_close() {
    let (entered, mut observed) = mpsc::unbounded_channel();
    let mut carrier = carrier();
    Arc::get_mut(&mut carrier.inner).unwrap().settings.acceptor = Arc::new(Panicking(entered));
    carrier.handle(&wire::encode(&Frame::new(
        "synthetic",
        Body::Handshake { payload: vec![1] },
    )));
    observed.recv().await.unwrap();
    let error = carrier.close().await.unwrap_err();
    assert_eq!(error.failures()[0].worker, Worker::Queue);
    assert_eq!(error.failures()[0].kind, JoinFailure::Panic);
}

struct Accept {
    entered: mpsc::UnboundedSender<()>,
    release: Arc<tokio::sync::Semaphore>,
}

impl Acceptor for Accept {
    fn accept(&self, _: &str, _: Vec<u8>, authorize: Authorize) -> Boxed<Result<Accepted, ()>> {
        let entered = self.entered.clone();
        let release = self.release.clone();
        Box::pin(async move {
            entered.send(()).unwrap();
            release.acquire().await.unwrap().forget();
            authorize(
                noise::PublicKey {
                    suite: "synthetic-suite".into(),
                    x25519_public_key: "eA==".into(),
                    mlkem768_public_key: "bQ==".into(),
                },
                "synthetic-authorization".into(),
            )
            .await?;
            Ok(Accepted {
                response: vec![1],
                cipher: Arc::new(Identity),
                harness_key_sha256: "a".repeat(64),
            })
        })
    }
}

#[tokio::test]
async fn cancelled_close_retains_a_handshake_and_does_not_admit_its_late_channel() {
    let mut carrier = carrier();
    let (entered, mut observed) = mpsc::unbounded_channel();
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (channels, mut received) = mpsc::unbounded_channel();
    let settings = &mut Arc::get_mut(&mut carrier.inner).unwrap().settings;
    settings.acceptor = Arc::new(Accept {
        entered,
        release: release.clone(),
    });
    settings.on_channel = Arc::new(move |channel| {
        channels
            .send(channel)
            .unwrap_or_else(|_| panic!("missing receiver"));
        Box::pin(async {})
    });
    carrier.handle(&wire::encode(&Frame::new(
        "synthetic",
        Body::Handshake { payload: vec![1] },
    )));
    observed.recv().await.unwrap();
    let mut close = Box::pin(carrier.close());
    pending(close.as_mut());
    drop(close);
    release.add_permits(1);
    assert_eq!(carrier.close().await, Ok(()));
    assert!(received.try_recv().is_err());
    assert!(carrier.inner.state().streams.is_empty());
}

#[tokio::test]
async fn a_real_channel_worker_panic_reaches_close() {
    let mut carrier = carrier();
    let (entered, mut observed) = mpsc::unbounded_channel();
    let (channels, mut received) = mpsc::unbounded_channel();
    let settings = &mut Arc::get_mut(&mut carrier.inner).unwrap().settings;
    settings.acceptor = Arc::new(Accept {
        entered,
        release: Arc::new(tokio::sync::Semaphore::new(1)),
    });
    settings.on_channel = Arc::new(move |_| {
        let channels = channels.clone();
        Box::pin(async move {
            channels.send(()).unwrap();
            panic!("synthetic channel panic")
        })
    });
    carrier.handle(&wire::encode(&Frame::new(
        "synthetic",
        Body::Handshake { payload: vec![1] },
    )));
    observed.recv().await.unwrap();
    received.recv().await.unwrap();
    let error = carrier.close().await.unwrap_err();
    assert_eq!(error.failures()[0].worker, Worker::Channel);
    assert_eq!(error.failures()[0].kind, JoinFailure::Panic);
}
