use super::*;
use crate::dots::carrier::{SocketError, test_support};
use futures_util::{Sink, Stream};
use std::{
    io,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
};

#[derive(Clone, Copy)]
enum Close {
    Success,
    Failed,
    AlreadyClosed,
    Pending,
}

struct Wire {
    incoming: mpsc::UnboundedReceiver<Result<Message, SocketError>>,
    close: Close,
    closes: Arc<AtomicUsize>,
}

impl Stream for Wire {
    type Item = Result<Message, SocketError>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.incoming.poll_recv(cx)
    }
}

impl Sink<Message> for Wire {
    type Error = SocketError;
    fn poll_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn start_send(self: Pin<&mut Self>, _: Message) -> Result<(), Self::Error> {
        Ok(())
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }
    fn poll_close(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.closes.fetch_add(1, Ordering::SeqCst);
        match self.close {
            Close::Success => Poll::Ready(Ok(())),
            Close::Failed => Poll::Ready(Err(SocketError::Io(io::Error::other(
                "synthetic socket error",
            )))),
            Close::AlreadyClosed => Poll::Ready(Err(SocketError::AlreadyClosed)),
            Close::Pending => Poll::Pending,
        }
    }
}

struct Reject;
impl relay::Acceptor for Reject {
    fn accept(
        &self,
        _: &str,
        _: Vec<u8>,
        _: relay::Authorize,
    ) -> Pin<Box<dyn Future<Output = Result<relay::Accepted, ()>> + Send>> {
        Box::pin(async { Err(()) })
    }
}

fn settings(output: relay::Output, clock: Arc<dyn Clock>) -> relay::Settings {
    relay::Settings {
        acceptor: Arc::new(Reject),
        authorize: Arc::new(|_, _, _| Box::pin(async { Err(()) })),
        output,
        clock,
        on_channel: Arc::new(|_| Box::pin(async {})),
        max_stream_queued_bytes: relay::DEFAULT_MAX_STREAM_QUEUED_BYTES,
        max_carrier_inbound_bytes: relay::DEFAULT_MAX_CARRIER_INBOUND_BYTES,
    }
}

fn socket(
    close: Close,
) -> (
    Socket,
    mpsc::UnboundedSender<Result<Message, SocketError>>,
    Arc<AtomicUsize>,
) {
    let (incoming, receiver) = mpsc::unbounded_channel();
    let closes = Arc::new(AtomicUsize::new(0));
    (
        Box::new(Wire {
            incoming: receiver,
            close,
            closes: closes.clone(),
        }),
        incoming,
        closes,
    )
}

#[tokio::test]
async fn finish_classifies_socket_errors_without_sensitive_text() {
    for (close, expected) in [
        (Close::Success, Ok(())),
        (Close::AlreadyClosed, Ok(())),
        (Close::Failed, Err(SocketCloseFailed::Failed)),
        (Close::Pending, Err(SocketCloseFailed::TimedOut)),
    ] {
        let (mut socket, _incoming, closes) = socket(close);
        assert_eq!(finish(&mut socket).await, expected);
        assert!(closes.load(Ordering::SeqCst) > 0);
    }
}

#[tokio::test]
async fn dial_failure_and_cancel_before_open_have_no_cleanup_failure() {
    let clock: Arc<dyn Clock> = Arc::new(test_support::clock().0);
    let refused: Connect =
        Arc::new(|_| Box::pin(async { Err(ConnectError { status: Some(403) }) }));
    let (_stop, mut cancel) = watch::channel(false);
    let outcome = serve(
        &refused,
        &clock,
        "wss://example.invalid/ws",
        "synthetic",
        |output| settings(output, clock.clone()),
        &mut cancel,
        &watch::channel(false).0,
    )
    .await;
    assert_eq!(outcome.ended, Ended::Dial { status: Some(403) });
    assert_eq!(outcome.cleanup, Ok(()));
    let (_stop, mut cancel) = watch::channel(true);
    let outcome = serve(
        &refused,
        &clock,
        "wss://example.invalid/ws",
        "synthetic",
        |output| settings(output, clock.clone()),
        &mut cancel,
        &watch::channel(false).0,
    )
    .await;
    assert_eq!(outcome.ended, Ended::Cancelled);
    assert_eq!(outcome.cleanup, Ok(()));
}

#[tokio::test]
async fn an_open_socket_reports_success_or_socket_only_cleanup_failure() {
    for close in [Close::Success, Close::AlreadyClosed, Close::Failed] {
        let clock: Arc<dyn Clock> = Arc::new(test_support::clock().0);
        let (socket, incoming, closes) = socket(close);
        let held = Arc::new(Mutex::new(Some(socket)));
        let connect: Connect = Arc::new(move |_| {
            let socket = held.lock().unwrap().take().unwrap();
            Box::pin(async move { Ok(socket) })
        });
        incoming.send(Ok(Message::Close(None))).unwrap();
        let (_stop, mut cancel) = watch::channel(false);
        let outcome = serve(
            &connect,
            &clock,
            "wss://example.invalid/ws",
            "synthetic",
            |output| settings(output, clock.clone()),
            &mut cancel,
            &watch::channel(false).0,
        )
        .await;
        assert_eq!(outcome.ended, Ended::Dropped { connected_ms: 0 });
        match close {
            Close::Success | Close::AlreadyClosed => assert_eq!(outcome.cleanup, Ok(())),
            Close::Failed => assert_eq!(
                outcome.cleanup.unwrap_err().failures(),
                &[CleanupFailure::Socket(SocketCloseFailed::Failed)]
            ),
            Close::Pending => unreachable!(),
        }
        assert_eq!(closes.load(Ordering::SeqCst), 1);
    }
}

struct PanicAccept(mpsc::UnboundedSender<()>);
impl relay::Acceptor for PanicAccept {
    fn accept(
        &self,
        _: &str,
        _: Vec<u8>,
        _: relay::Authorize,
    ) -> Pin<Box<dyn Future<Output = Result<relay::Accepted, ()>> + Send>> {
        let entered = self.0.clone();
        Box::pin(async move {
            entered.send(()).unwrap();
            panic!("synthetic relay panic")
        })
    }
}

#[tokio::test]
async fn serve_keeps_the_end_reason_and_both_cleanup_failures_and_closes_after_relay_failure() {
    for cancelled in [false, true] {
        let clock: Arc<dyn Clock> = Arc::new(test_support::clock().0);
        let (socket, incoming, closes) = socket(Close::Failed);
        let held = Arc::new(Mutex::new(Some(socket)));
        let connect: Connect = Arc::new(move |_| {
            let socket = held.lock().unwrap().take().unwrap();
            Box::pin(async move { Ok(socket) })
        });
        let (entered, mut observed) = mpsc::unbounded_channel();
        let (stop, mut cancel) = watch::channel(false);
        let (ended, finished) = watch::channel(false);
        let task = tokio::spawn(async move {
            serve(
                &connect,
                &clock,
                "wss://example.invalid/ws",
                "synthetic",
                |output| {
                    let mut settings = settings(output, clock.clone());
                    settings.acceptor = Arc::new(PanicAccept(entered));
                    settings
                },
                &mut cancel,
                &ended,
            )
            .await
        });
        incoming
            .send(Ok(Message::Binary(
                super::super::relay_wire::encode(&super::super::relay_wire::Frame::new(
                    "synthetic",
                    super::super::relay_wire::Body::Handshake { payload: vec![1] },
                ))
                .into(),
            )))
            .unwrap();
        observed.recv().await.unwrap();
        if cancelled {
            stop.send_replace(true);
        } else {
            incoming.send(Ok(Message::Close(None))).unwrap();
        }
        let outcome = task.await.unwrap();
        assert_eq!(
            outcome.ended,
            if cancelled {
                Ended::Cancelled
            } else {
                Ended::Dropped { connected_ms: 0 }
            }
        );
        assert!(*finished.borrow());
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        let error = outcome.cleanup.unwrap_err();
        assert!(matches!(
            error.failures(),
            [
                CleanupFailure::Relay(_),
                CleanupFailure::Socket(SocketCloseFailed::Failed)
            ]
        ));
        assert!(!format!("{error:?} {error}").contains("synthetic"));
    }
}
