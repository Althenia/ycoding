use super::relay::{self, Accepted, Acceptor, Authorize};
use super::relay_wire::{self as wire, Body, Frame, RESET_REASON};
use super::rendezvous::{
    CONNECT_TIMEOUT_MS, Ended, KEEPALIVE_INTERVAL_MS, Outcome, PONG_TIMEOUT_MS, serve,
    socket_config,
};
use super::test_support::{self, TestClock, TestDial, TestSocket};
use super::{Clock, Connect, ConnectError, Socket};
use futures_util::{SinkExt, StreamExt};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

struct Rejecting;
impl Acceptor for Rejecting {
    fn accept(
        &self,
        _: &str,
        _: Vec<u8>,
        _: Authorize,
    ) -> Pin<Box<dyn Future<Output = Result<Accepted, ()>> + Send>> {
        Box::pin(async { Err(()) })
    }
}

fn settings(output: relay::Output, clock: Arc<dyn Clock>) -> relay::Settings {
    relay::Settings {
        acceptor: Arc::new(Rejecting),
        authorize: Arc::new(|_, _, _| Box::pin(async { Err(()) })),
        output,
        clock,
        on_channel: Arc::new(|_| Box::pin(async {})),
        max_stream_queued_bytes: relay::DEFAULT_MAX_STREAM_QUEUED_BYTES,
        max_carrier_inbound_bytes: relay::DEFAULT_MAX_CARRIER_INBOUND_BYTES,
    }
}

fn recording(dial: TestDial, requests: Arc<Mutex<Vec<(String, String)>>>) -> Connect {
    Arc::new(move |request| {
        requests.lock().unwrap().push((
            request.uri().to_string(),
            request
                .headers()
                .get("x-request-id")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned(),
        ));
        let socket = dial();
        Box::pin(async move {
            socket
                .await
                .map(|socket| Box::new(socket) as Socket)
                .map_err(|_| ConnectError { status: None })
        })
    })
}

struct Running {
    peer: TestSocket,
    clock: TestClock,
    armed: mpsc::UnboundedReceiver<u64>,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Outcome>,
    ended: watch::Receiver<bool>,
    requests: Arc<Mutex<Vec<(String, String)>>>,
}

async fn start() -> Running {
    let (dial, mut peers) = test_support::dial();
    let (clock, armed) = test_support::clock();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let connect = recording(dial, requests.clone());
    let (stop, mut cancel) = watch::channel(false);
    let shared: Arc<dyn Clock> = Arc::new(clock.clone());
    let (ended_signal, ended) = watch::channel(false);
    let task = tokio::spawn(async move {
        serve(
            &connect,
            &shared,
            "wss://rendezvous.chatgpt.com/ws?x=1",
            "0123456789abcdef0123456789abcdef",
            |output| settings(output, shared.clone()),
            &mut cancel,
            &ended_signal,
        )
        .await
    });
    let peer = tokio::time::timeout(Duration::from_secs(5), peers.recv())
        .await
        .unwrap()
        .unwrap();
    Running {
        peer,
        clock,
        armed,
        stop,
        task,
        ended,
        requests,
    }
}

async fn next(
    running: &mut Running,
) -> Option<Result<Message, tokio_tungstenite::tungstenite::Error>> {
    tokio::time::timeout(Duration::from_secs(5), running.peer.next())
        .await
        .unwrap()
}

async fn armed(running: &mut Running) -> u64 {
    tokio::time::timeout(Duration::from_secs(5), running.armed.recv())
        .await
        .unwrap()
        .unwrap()
}

async fn finished(running: Running) -> Outcome {
    tokio::time::timeout(Duration::from_secs(5), running.task)
        .await
        .unwrap()
        .unwrap()
}

#[test]
fn socket_limits_match_the_executor_transport_contract() {
    assert_eq!(KEEPALIVE_INTERVAL_MS, 30_000);
    assert_eq!(PONG_TIMEOUT_MS, 60_000);
    assert_eq!(CONNECT_TIMEOUT_MS, 10_000);
    assert_eq!(super::rendezvous::WRITE_TIMEOUT_MS, 60_000);
    let config = socket_config();
    assert_eq!(config.max_message_size, Some(256 * 1024));
    assert_eq!(config.max_frame_size, Some(256 * 1024));
}

#[tokio::test]
async fn the_dial_carries_a_request_id_and_binary_frames_reach_the_relay_carrier() {
    let mut running = start().await;
    assert_eq!(
        running.requests.lock().unwrap().as_slice(),
        [(
            "wss://rendezvous.chatgpt.com/ws?x=1".to_owned(),
            "req_0123456789abcdef0123456789abcdef".to_owned()
        )]
    );
    running
        .peer
        .send(Message::Text("ignored text".into()))
        .await
        .unwrap();
    let handshake = wire::encode(&Frame::new(
        "stream-1",
        Body::Handshake {
            payload: vec![1, 2, 3],
        },
    ));
    running
        .peer
        .send(Message::Binary(handshake.into()))
        .await
        .unwrap();
    let Some(Ok(Message::Binary(reply))) = next(&mut running).await else {
        panic!("no binary reply")
    };
    assert_eq!(
        wire::decode(&reply),
        Ok(Frame::new(
            "stream-1",
            Body::Reset {
                reason: RESET_REASON.into()
            }
        ))
    );
    running.stop.send_replace(true);
    assert_eq!(
        finished(running).await,
        Outcome {
            ended: Ended::Cancelled,
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn a_silent_peer_is_dropped_when_the_pong_deadline_passes() {
    let mut running = start().await;
    assert_eq!(armed(&mut running).await, KEEPALIVE_INTERVAL_MS);
    running.clock.advance_to(KEEPALIVE_INTERVAL_MS);
    assert!(matches!(
        next(&mut running).await,
        Some(Ok(Message::Ping(_)))
    ));
    running
        .clock
        .advance_to(KEEPALIVE_INTERVAL_MS + PONG_TIMEOUT_MS);
    assert_eq!(
        finished(running).await,
        Outcome {
            ended: Ended::Dropped {
                connected_ms: KEEPALIVE_INTERVAL_MS + PONG_TIMEOUT_MS
            },
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn a_pong_clears_the_deadline_and_a_deferred_tick_pings_immediately() {
    let mut running = start().await;
    running.clock.advance_to(30_000);
    assert!(matches!(
        next(&mut running).await,
        Some(Ok(Message::Ping(_)))
    ));
    running
        .peer
        .send(Message::Pong(Default::default()))
        .await
        .unwrap();
    running.clock.advance_to(60_000);
    assert!(matches!(
        next(&mut running).await,
        Some(Ok(Message::Ping(_)))
    ));
    running.clock.advance_to(90_000);
    tokio::time::sleep(Duration::from_millis(100)).await;
    running
        .peer
        .send(Message::Pong(Default::default()))
        .await
        .unwrap();
    assert!(matches!(
        next(&mut running).await,
        Some(Ok(Message::Ping(_)))
    ));
    running.stop.send_replace(true);
    assert_eq!(
        finished(running).await,
        Outcome {
            ended: Ended::Cancelled,
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn a_peer_close_ends_the_connection_with_its_lifetime() {
    let mut running = start().await;
    running.clock.advance_to(5_000);
    tokio::time::sleep(Duration::from_millis(50)).await;
    running.peer.close(None).await.unwrap();
    assert_eq!(
        finished(running).await,
        Outcome {
            ended: Ended::Dropped {
                connected_ms: 5_000
            },
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn the_ended_signal_flips_when_the_connection_ends_by_peer_close_or_cancellation() {
    let mut running = start().await;
    assert!(!*running.ended.borrow());
    running.peer.close(None).await.unwrap();
    let mut ended = running.ended.clone();
    tokio::time::timeout(Duration::from_secs(5), ended.wait_for(|ended| *ended))
        .await
        .unwrap()
        .unwrap();
    assert!(matches!(
        finished(running).await,
        Outcome {
            ended: Ended::Dropped { .. },
            cleanup: Ok(())
        }
    ));
    let running = start().await;
    let mut ended = running.ended.clone();
    running.stop.send_replace(true);
    tokio::time::timeout(Duration::from_secs(5), ended.wait_for(|ended| *ended))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        finished(running).await,
        Outcome {
            ended: Ended::Cancelled,
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn cancellation_closes_the_socket() {
    let mut running = start().await;
    running.stop.send_replace(true);
    let closed = next(&mut running).await;
    assert!(closed.is_none() || matches!(closed, Some(Ok(Message::Close(_))) | Some(Err(_))));
    assert_eq!(
        finished(running).await,
        Outcome {
            ended: Ended::Cancelled,
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn dial_failures_report_their_status_and_a_stalled_dial_times_out() {
    let (clock, mut armed) = test_support::clock();
    let shared: Arc<dyn Clock> = Arc::new(clock.clone());
    let (_stop, mut cancel) = watch::channel(false);
    let refused: Connect =
        Arc::new(|_| Box::pin(async { Err(ConnectError { status: Some(403) }) }));
    assert_eq!(
        serve(
            &refused,
            &shared,
            "wss://rendezvous.chatgpt.com/ws",
            "e",
            |output| settings(output, shared.clone()),
            &mut cancel,
            &watch::channel(false).0
        )
        .await,
        Outcome {
            ended: Ended::Dial { status: Some(403) },
            cleanup: Ok(())
        }
    );
    let stalled: Connect =
        Arc::new(|_| Box::pin(std::future::pending::<Result<Socket, ConnectError>>()));
    let task = {
        let shared = shared.clone();
        tokio::spawn(async move {
            let (_stop, mut cancel) = watch::channel(false);
            serve(
                &stalled,
                &shared,
                "wss://rendezvous.chatgpt.com/ws",
                "e",
                |output| settings(output, shared.clone()),
                &mut cancel,
                &watch::channel(false).0,
            )
            .await
        })
    };
    assert_eq!(armed.recv().await, Some(CONNECT_TIMEOUT_MS));
    clock.advance_to(CONNECT_TIMEOUT_MS);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap(),
        Outcome {
            ended: Ended::Dial { status: None },
            cleanup: Ok(())
        }
    );
}

#[tokio::test]
async fn cancellation_during_the_dial_stops_without_a_socket() {
    let (clock, _armed) = test_support::clock();
    let shared: Arc<dyn Clock> = Arc::new(clock);
    let (stop, mut cancel) = watch::channel(false);
    let stalled: Connect =
        Arc::new(|_| Box::pin(std::future::pending::<Result<Socket, ConnectError>>()));
    let task = tokio::spawn(async move {
        serve(
            &stalled,
            &shared,
            "wss://rendezvous.chatgpt.com/ws",
            "e",
            |output| settings(output, shared.clone()),
            &mut cancel,
            &watch::channel(false).0,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    stop.send_replace(true);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap(),
        Outcome {
            ended: Ended::Cancelled,
            cleanup: Ok(())
        }
    );
}
