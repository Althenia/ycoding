use super::{Clock, Connect, ConnectError, Socket, cancelled, relay, until};
use futures_util::{SinkExt, StreamExt};
use std::{future::Future, pin::Pin, sync::Arc, time::Duration};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::{
    Error as SocketError, Message,
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    protocol::WebSocketConfig,
};

#[cfg(test)]
#[path = "rendezvous_shutdown_tests.rs"]
mod shutdown_tests;

pub const KEEPALIVE_INTERVAL_MS: u64 = 30_000;
pub const PONG_TIMEOUT_MS: u64 = 60_000;
pub const WRITE_TIMEOUT_MS: u64 = 60_000;
pub const CONNECT_TIMEOUT_MS: u64 = 10_000;
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

pub fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES))
}

#[derive(Debug, Eq, PartialEq)]
pub enum Ended {
    Cancelled,
    Dial { status: Option<u16> },
    Dropped { connected_ms: u64 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SocketCloseFailed {
    Failed,
    TimedOut,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CleanupFailure {
    Relay(relay::CloseFailed),
    Socket(SocketCloseFailed),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupFailed {
    failures: Vec<CleanupFailure>,
}

impl CleanupFailed {
    #[cfg(test)]
    pub fn failures(&self) -> &[CleanupFailure] {
        &self.failures
    }
}

impl std::fmt::Display for CleanupFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Rendezvous cleanup failed in {} stages",
            self.failures.len()
        )
    }
}

impl std::error::Error for CleanupFailed {}

#[derive(Debug, Eq, PartialEq)]
pub struct Outcome {
    pub ended: Ended,
    pub cleanup: Result<(), CleanupFailed>,
}

impl Outcome {
    fn unopened(ended: Ended) -> Self {
        Self {
            ended,
            cleanup: Ok(()),
        }
    }
}

fn request_id(entropy: &str) -> String {
    format!("req_{entropy}")
}

type Pending<'a> = Option<Pin<Box<dyn Future<Output = ()> + Send + 'a>>>;

async fn waiting(deadline: &mut Pending<'_>) {
    match deadline {
        Some(deadline) => deadline.await,
        None => std::future::pending().await,
    }
}

async fn write(socket: &mut Socket, message: Message) -> Result<(), ()> {
    match tokio::time::timeout(
        Duration::from_millis(WRITE_TIMEOUT_MS),
        SinkExt::<Message>::send(socket, message),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

async fn finish(socket: &mut Socket) -> Result<(), SocketCloseFailed> {
    match tokio::time::timeout(Duration::from_secs(1), SinkExt::<Message>::close(socket)).await {
        Ok(Ok(())) | Ok(Err(SocketError::ConnectionClosed | SocketError::AlreadyClosed)) => Ok(()),
        Ok(Err(_)) => Err(SocketCloseFailed::Failed),
        Err(_) => Err(SocketCloseFailed::TimedOut),
    }
}

pub async fn serve(
    connect: &Connect,
    clock: &Arc<dyn Clock>,
    url: &str,
    entropy: &str,
    carrier: impl FnOnce(relay::Output) -> relay::Settings,
    cancel: &mut watch::Receiver<bool>,
    ended: &watch::Sender<bool>,
) -> Outcome {
    let Ok(mut request) = url.into_client_request() else {
        return Outcome::unopened(Ended::Dial { status: None });
    };
    let Ok(value) = HeaderValue::from_str(&request_id(entropy)) else {
        return Outcome::unopened(Ended::Dial { status: None });
    };
    request
        .headers_mut()
        .insert(HeaderName::from_static("x-request-id"), value);
    let dial = connect(request);
    let deadline = clock.now() + CONNECT_TIMEOUT_MS;
    let opened = until(cancel, async {
        tokio::select! {
            biased;
            socket = dial => socket,
            _ = clock.sleep_until(deadline) => Err(ConnectError { status: None }),
        }
    })
    .await;
    let mut socket = match opened {
        None => return Outcome::unopened(Ended::Cancelled),
        Some(Err(error)) => {
            return Outcome::unopened(Ended::Dial {
                status: error.status,
            });
        }
        Some(Ok(socket)) => socket,
    };
    let connected_at = clock.now();
    let (output, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();
    let carrier = relay::Carrier::new(carrier(Arc::new(move |bytes| {
        output.send(bytes).map_err(|_| ())
    })));
    let mut next_ping = clock.sleep_until(connected_at + KEEPALIVE_INTERVAL_MS);
    let mut pong_deadline: Pending<'_> = None;
    let mut tick_pending = false;
    let mut stopped = false;
    loop {
        tokio::select! {
            biased;
            _ = cancelled(cancel) => {
                stopped = true;
                break;
            }
            message = socket.next() => match message {
                Some(Ok(Message::Binary(bytes))) => carrier.handle(&bytes),
                Some(Ok(Message::Ping(_))) => {
                    if SinkExt::<Message>::flush(&mut socket).await.is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Pong(_))) => {
                    if pong_deadline.take().is_some() && tick_pending {
                        tick_pending = false;
                        if write(&mut socket, Message::Ping(Default::default())).await.is_err() {
                            break;
                        }
                        pong_deadline = Some(clock.sleep_until(clock.now() + PONG_TIMEOUT_MS));
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            Some(bytes) = outgoing.recv() => {
                if write(&mut socket, Message::Binary(bytes.into())).await.is_err() {
                    break;
                }
            }
            _ = &mut next_ping => {
                next_ping = clock.sleep_until(clock.now() + KEEPALIVE_INTERVAL_MS);
                if pong_deadline.is_some() {
                    tick_pending = true;
                } else {
                    if write(&mut socket, Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                    pong_deadline = Some(clock.sleep_until(clock.now() + PONG_TIMEOUT_MS));
                }
            }
            _ = waiting(&mut pong_deadline) => break,
        }
    }
    let connected_ms = clock.now().saturating_sub(connected_at);
    ended.send_replace(true);
    let mut failures = Vec::new();
    if let Err(error) = carrier.close().await {
        failures.push(CleanupFailure::Relay(error));
    }
    if let Err(error) = finish(&mut socket).await {
        failures.push(CleanupFailure::Socket(error));
    }
    let ended = if stopped {
        Ended::Cancelled
    } else {
        Ended::Dropped { connected_ms }
    };
    let cleanup = if failures.is_empty() {
        Ok(())
    } else {
        Err(CleanupFailed { failures })
    };
    Outcome { ended, cleanup }
}
