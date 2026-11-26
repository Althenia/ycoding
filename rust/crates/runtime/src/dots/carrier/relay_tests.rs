use super::relay::{
    Accepted, Acceptor, Authorize, Authorizer, Carrier, Channel, Cipher, Closed, OnChannel, Output,
    Settings,
};
use super::relay_wire::{
    self as wire, Body, Frame, Invalid, MAX_PENDING_BYTES, MessageDecoder, OrderedCiphertexts,
    RECORD_PLAINTEXT_BYTES, RESET_REASON,
};
use super::test_support::{self, TestClock, WALL_BASE};
use std::{
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore, mpsc};
use ycoding_core::dots::noise;

fn frame(stream: &str, body: Body) -> Vec<u8> {
    wire::encode(&Frame::new(stream, body))
}

#[test]
fn frames_encode_to_the_canonical_protobuf_bytes() {
    assert_eq!(
        wire::encode(&Frame::new("s1", Body::Heartbeat)),
        [0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x4a, 0x00]
    );
    assert_eq!(
        wire::encode(&Frame::new("s1", Body::Ack)),
        [0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x32, 0x00]
    );
    assert_eq!(
        wire::encode(&Frame::new(
            "s1",
            Body::Data {
                seq: 7,
                segment_index: 0,
                segment_count: 1,
                payload: vec![0xaa, 0xbb]
            }
        )),
        [
            0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x2a, 0x08, 0x08, 0x07, 0x18, 0x01, 0x22, 0x02,
            0xaa, 0xbb
        ]
    );
    assert_eq!(
        wire::encode(&Frame::new("s1", Body::Resume { next_seq: 0 })),
        [0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x3a, 0x02, 0x08, 0x00]
    );
    assert_eq!(
        wire::encode(&Frame::new("s1", Body::Resume { next_seq: 300 })),
        [
            0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x3a, 0x03, 0x08, 0xac, 0x02
        ]
    );
    assert_eq!(
        wire::encode(&Frame::new("s1", Body::Reset { reason: "x".into() })),
        [
            0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x42, 0x03, 0x0a, 0x01, 0x78
        ]
    );
    assert_eq!(
        wire::encode(&Frame::new("s1", Body::Handshake { payload: vec![1] })),
        [
            0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x52, 0x03, 0x0a, 0x01, 0x01
        ]
    );
    let mut traced = Frame::new("s1", Body::Heartbeat);
    traced.ack = Some(5);
    traced.ack_bits = Some(9);
    traced.traceparent = Some("t".into());
    traced.tracestate = Some("u".into());
    assert_eq!(
        wire::encode(&traced),
        [
            0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x18, 0x05, 0x20, 0x09, 0x4a, 0x00, 0x5a, 0x01,
            0x74, 0x62, 0x01, 0x75
        ]
    );
    let mut zero = Frame::new("s1", Body::Heartbeat);
    zero.ack = Some(0);
    zero.ack_bits = Some(0);
    assert_eq!(
        wire::encode(&zero),
        wire::encode(&Frame::new("s1", Body::Heartbeat))
    );
    assert_eq!(
        wire::encode(&Frame::new("", Body::Heartbeat)),
        [0x08, 0x01, 0x4a, 0x00]
    );
}

#[test]
fn frames_round_trip_and_ignore_unknown_fields() {
    for body in [
        Body::Data {
            seq: u32::MAX,
            segment_index: 0,
            segment_count: 1,
            payload: vec![0; 300],
        },
        Body::Ack,
        Body::Resume { next_seq: 0 },
        Body::Resume { next_seq: u32::MAX },
        Body::Reset {
            reason: RESET_REASON.into(),
        },
        Body::Heartbeat,
        Body::Handshake {
            payload: vec![7; 4000],
        },
    ] {
        let mut original = Frame::new("stream-é", body);
        original.ack = Some(3);
        original.ack_bits = Some(u32::MAX);
        original.traceparent = Some("00-trace".into());
        original.tracestate = Some("a=b".into());
        assert_eq!(wire::decode(&wire::encode(&original)), Ok(original));
    }
    let mut bytes = wire::encode(&Frame::new("s1", Body::Ack));
    bytes.extend_from_slice(&[0x78, 0x01]);
    bytes.extend_from_slice(&[0x7a, 0x02, 0x01, 0x02]);
    bytes.extend_from_slice(&[0x79, 1, 2, 3, 4, 5, 6, 7, 8]);
    bytes.extend_from_slice(&[0x7d, 1, 2, 3, 4]);
    assert_eq!(wire::decode(&bytes), Ok(Frame::new("s1", Body::Ack)));
    let mut later = frame("s1", Body::Ack);
    later.extend(frame("s1", Body::Heartbeat));
    assert_eq!(wire::decode(&later).unwrap().body, Body::Heartbeat);
}

#[test]
fn invalid_frames_are_rejected() {
    let data = |index, count, payload: Vec<u8>| {
        frame(
            "s1",
            Body::Data {
                seq: 1,
                segment_index: index,
                segment_count: count,
                payload,
            },
        )
    };
    for (name, bytes) in [
        ("empty", vec![]),
        (
            "wrong version",
            vec![0x08, 0x02, 0x12, 0x02, 0x73, 0x31, 0x4a, 0x00],
        ),
        ("missing version", vec![0x12, 0x02, 0x73, 0x31, 0x4a, 0x00]),
        ("missing stream", vec![0x08, 0x01, 0x4a, 0x00]),
        (
            "blank stream",
            wire::encode(&Frame::new(" \u{3000}", Body::Heartbeat)),
        ),
        ("missing body", vec![0x08, 0x01, 0x12, 0x02, 0x73, 0x31]),
        ("segmented", data(1, 1, vec![1])),
        ("zero segments", data(0, 0, vec![1])),
        ("two segments", data(0, 2, vec![1])),
        ("empty payload", data(0, 1, vec![])),
        (
            "empty reset",
            frame(
                "s1",
                Body::Reset {
                    reason: String::new(),
                },
            ),
        ),
        (
            "empty handshake",
            frame("s1", Body::Handshake { payload: vec![] }),
        ),
        ("truncated varint", vec![0x08, 0x81]),
        ("truncated stream", vec![0x08, 0x01, 0x12, 0x05, 0x73]),
        ("version wire type", vec![0x0a, 0x01, 0x01]),
        ("stream wire type", vec![0x08, 0x01, 0x10, 0x01]),
        (
            "unsupported wire type",
            vec![0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x4a, 0x00, 0x7b],
        ),
        (
            "truncated unknown fixed",
            vec![0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x4a, 0x00, 0x79, 1, 2],
        ),
        (
            "payload past data",
            vec![
                0x08, 0x01, 0x12, 0x02, 0x73, 0x31, 0x2a, 0x03, 0x22, 0x05, 0x01,
            ],
        ),
        ("oversized", vec![0; wire::MAX_WEBSOCKET_MESSAGE_BYTES + 1]),
    ] {
        assert_eq!(wire::decode(&bytes), Err(Invalid), "{name}");
    }
    let mut at_limit = frame("s1", Body::Heartbeat);
    at_limit.extend_from_slice(&[0x7a]);
    let padding = wire::MAX_WEBSOCKET_MESSAGE_BYTES - at_limit.len() - 3;
    at_limit.extend_from_slice(&[
        0x80 | (padding & 0x7f) as u8,
        ((padding >> 7) & 0x7f) as u8 | 0x80,
        (padding >> 14) as u8,
    ]);
    at_limit.extend(std::iter::repeat_n(0, padding));
    assert_eq!(at_limit.len(), wire::MAX_WEBSOCKET_MESSAGE_BYTES);
    assert!(wire::decode(&at_limit).is_ok());
}

#[test]
fn json_rpc_messages_are_length_prefixed_and_reassembled_across_records() {
    assert_eq!(
        wire::frame_message(b"abc"),
        Ok(vec![0, 0, 0, 3, b'a', b'b', b'c'])
    );
    assert_eq!(wire::frame_message(b""), Err(Invalid));
    let mut decoder = MessageDecoder::default();
    assert_eq!(decoder.push(&[0, 0, 0]), Ok(vec![]));
    assert_eq!(decoder.push(&[3, b'a']), Ok(vec![]));
    assert_eq!(decoder.buffered_bytes(), 5);
    assert_eq!(
        decoder.push(b"bc\x00\x00\x00\x01z\x00\x00"),
        Ok(vec![b"abc".to_vec(), b"z".to_vec()])
    );
    assert_eq!(decoder.buffered_bytes(), 2);
    assert_eq!(decoder.push(&[0, 1, b'q']), Ok(vec![b"q".to_vec()]));
    assert_eq!(decoder.buffered_bytes(), 0);
    assert_eq!(MessageDecoder::default().push(&[0, 0, 0, 0]), Err(Invalid));
    assert_eq!(
        MessageDecoder::default().push(&(wire::MAX_JSONRPC_MESSAGE_BYTES as u32 + 1).to_be_bytes()),
        Err(Invalid)
    );
    assert_eq!(
        MessageDecoder::default().push(&vec![1; RECORD_PLAINTEXT_BYTES + 1]),
        Err(Invalid)
    );
    assert!(
        MessageDecoder::default()
            .push(&(wire::MAX_JSONRPC_MESSAGE_BYTES as u32).to_be_bytes())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn ciphertexts_are_released_in_order_within_a_bounded_reorder_window() {
    let mut ordered = OrderedCiphertexts::default();
    assert_eq!(ordered.push(0, vec![0]), Ok(vec![vec![0]]));
    assert_eq!(ordered.push(0, vec![9]), Ok(vec![]));
    assert_eq!(ordered.push(3, vec![3]), Ok(vec![]));
    assert_eq!(ordered.push(2, vec![2]), Ok(vec![]));
    assert_eq!(ordered.push(2, vec![8]), Ok(vec![]));
    assert_eq!(ordered.pending_bytes(), 2);
    assert_eq!(
        ordered.push(1, vec![1]),
        Ok(vec![vec![1], vec![2], vec![3]])
    );
    assert_eq!(ordered.pending_bytes(), 0);
    assert_eq!(ordered.push(3, vec![7]), Ok(vec![]));
    assert_eq!(ordered.push(4, vec![4]), Ok(vec![vec![4]]));
    assert_eq!(ordered.push(5 + 65, vec![1]), Err(Invalid));
    assert_eq!(ordered.push(5 + 64, vec![1]), Ok(vec![]));
}

#[test]
fn pending_ciphertext_bytes_are_capped() {
    let mut ordered = OrderedCiphertexts::default();
    let chunk = 65_535;
    let allowed = MAX_PENDING_BYTES / chunk;
    for seq in 1..=allowed as u32 {
        assert_eq!(ordered.push(seq, vec![0; chunk]), Ok(vec![]));
    }
    assert_eq!(
        ordered.push(allowed as u32 + 1, vec![0; chunk]),
        Err(Invalid)
    );
}

struct Xor;
impl Cipher for Xor {
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()> {
        if plaintext.windows(4).any(|window| window == b"FAIL") {
            return Err(());
        }
        Ok(plaintext.iter().map(|byte| byte ^ 0x5a).collect())
    }
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ()> {
        if ciphertext == [0xde, 0xad] {
            return Err(());
        }
        Ok(ciphertext.iter().map(|byte| byte ^ 0x5a).collect())
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Mode {
    Accept,
    Fail,
    SkipAuthorize,
    Block,
}

struct Fake {
    mode: Mutex<Mode>,
    gate: Arc<Semaphore>,
    calls: AtomicUsize,
}
impl Acceptor for Fake {
    fn accept(
        &self,
        _: &str,
        _: Vec<u8>,
        authorize: Authorize,
    ) -> Pin<Box<dyn Future<Output = Result<Accepted, ()>> + Send>> {
        let mode = *self.mode.lock().unwrap();
        self.calls.fetch_add(1, Ordering::SeqCst);
        let gate = self.gate.clone();
        Box::pin(async move {
            match mode {
                Mode::Fail => return Err(()),
                Mode::SkipAuthorize => {}
                Mode::Accept | Mode::Block => {
                    if mode == Mode::Block {
                        gate.acquire().await.unwrap().forget();
                    }
                    authorize(
                        noise::PublicKey {
                            suite: "suite".into(),
                            x25519_public_key: "eA==".into(),
                            mlkem768_public_key: "bQ==".into(),
                        },
                        "harness-authorization".into(),
                    )
                    .await?;
                }
            }
            Ok(Accepted {
                response: b"handshake-response".to_vec(),
                cipher: Arc::new(Xor),
            })
        })
    }
}

pub(super) struct Harness {
    carrier: Carrier,
    fake: Arc<Fake>,
    sent: Arc<Mutex<Vec<Frame>>>,
    output_ready: Arc<Notify>,
    refuse_output: Arc<AtomicBool>,
    validations: Arc<Mutex<Vec<(String, String)>>>,
    deny_validation: Arc<AtomicBool>,
    channels: mpsc::UnboundedReceiver<Channel>,
    finish_immediately: Arc<AtomicBool>,
    clock: TestClock,
}

impl Harness {
    fn new(max_stream: usize, max_carrier: usize) -> Self {
        let fake = Arc::new(Fake {
            mode: Mutex::new(Mode::Accept),
            gate: Arc::new(Semaphore::new(0)),
            calls: AtomicUsize::new(0),
        });
        let sent = Arc::new(Mutex::new(Vec::new()));
        let output_ready = Arc::new(Notify::new());
        let refuse_output = Arc::new(AtomicBool::new(false));
        let output: Output = {
            let (sent, ready, refuse) = (sent.clone(), output_ready.clone(), refuse_output.clone());
            Arc::new(move |bytes| {
                if refuse.load(Ordering::SeqCst) {
                    return Err(());
                }
                sent.lock()
                    .unwrap()
                    .push(wire::decode(&bytes).expect("carrier emitted an undecodable frame"));
                ready.notify_one();
                Ok(())
            })
        };
        let validations = Arc::new(Mutex::new(Vec::new()));
        let deny_validation = Arc::new(AtomicBool::new(false));
        let authorize: Authorizer = {
            let (validations, deny) = (validations.clone(), deny_validation.clone());
            Arc::new(move |key, authorization, stream| {
                let (validations, deny) = (validations.clone(), deny.clone());
                Box::pin(async move {
                    assert_eq!(key.x25519_public_key, "eA==");
                    validations.lock().unwrap().push((stream, authorization));
                    if deny.load(Ordering::SeqCst) {
                        Err(())
                    } else {
                        Ok(())
                    }
                })
            })
        };
        let (open, channels) = mpsc::unbounded_channel();
        let finish_immediately = Arc::new(AtomicBool::new(false));
        let on_channel: OnChannel = {
            let finish = finish_immediately.clone();
            Arc::new(move |channel| {
                let (open, finish) = (open.clone(), finish.clone());
                Box::pin(async move {
                    let mut closed = channel.closed();
                    let _ = open.send(channel);
                    if finish.load(Ordering::SeqCst) {
                        return;
                    }
                    let _ = closed.wait_for(|closed| *closed).await;
                })
            })
        };
        let (clock, _armed) = test_support::clock();
        let carrier = Carrier::new(Settings {
            acceptor: fake.clone(),
            authorize,
            output,
            clock: Arc::new(clock.clone()),
            on_channel,
            max_stream_queued_bytes: max_stream,
            max_carrier_inbound_bytes: max_carrier,
        });
        Self {
            carrier,
            fake,
            sent,
            output_ready,
            refuse_output,
            validations,
            deny_validation,
            channels,
            finish_immediately,
            clock,
        }
    }

    pub(super) fn standard() -> Self {
        Self::new(4 * 1024 * 1024, 32 * 1024 * 1024)
    }

    fn deliver(&self, stream: &str, body: Body) {
        self.carrier.handle(&frame(stream, body));
    }

    fn handshake(&self, stream: &str) {
        self.deliver(
            stream,
            Body::Handshake {
                payload: vec![1, 2, 3],
            },
        );
    }

    fn data(&self, stream: &str, seq: u32, plaintext_record: &[u8]) {
        self.deliver(
            stream,
            Body::Data {
                seq,
                segment_index: 0,
                segment_count: 1,
                payload: plaintext_record.iter().map(|byte| byte ^ 0x5a).collect(),
            },
        );
    }

    pub(super) fn message(&self, stream: &str, seq: u32, message: &[u8]) {
        self.data(stream, seq, &wire::frame_message(message).unwrap());
    }

    fn sent(&self) -> Vec<Frame> {
        self.sent.lock().unwrap().clone()
    }

    fn resets(&self, stream: &str) -> usize {
        self.sent()
            .iter()
            .filter(|frame| {
                frame.stream_id == stream
                    && matches!(&frame.body, Body::Reset { reason } if reason == RESET_REASON)
            })
            .count()
    }

    pub(super) async fn open(&mut self, stream: &str) -> Channel {
        self.handshake(stream);
        tokio::time::timeout(Duration::from_secs(5), self.channels.recv())
            .await
            .expect("no channel opened")
            .unwrap()
    }

    pub(super) async fn response(
        &self,
        stream: &str,
        id: u32,
    ) -> ycoding_core::ycoding_schema::JsonValue {
        use ycoding_core::ycoding_schema::{JsonValue, parse_json};
        tokio::time::timeout(Duration::from_secs(5), async {
            let mut decoder = MessageDecoder::default();
            let mut seen = 0;
            loop {
                {
                    let sent = self.sent.lock().unwrap();
                    for frame in &sent[seen..] {
                        if frame.stream_id == stream && let Body::Data { payload, .. } = &frame.body {
                            for message in decoder.push(&Xor.decrypt(payload).unwrap()).unwrap() {
                                let response = parse_json(std::str::from_utf8(&message).unwrap()).unwrap();
                                if matches!(&response, JsonValue::Object(object) if object.get(&"id".into()) == Some(&JsonValue::Number(f64::from(id)))) {
                                    return response;
                                }
                            }
                        }
                    }
                    seen = sent.len();
                }
                self.output_ready.notified().await;
            }
        })
        .await
        .expect("no matching RPC response")
    }

    pub(super) async fn close(self) {
        self.carrier.close().await.unwrap();
    }
}

async fn eventually(mut condition: impl FnMut() -> bool) {
    for _ in 0..500 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition was not reached");
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(100)).await;
}

#[tokio::test]
async fn a_handshake_is_authorized_once_answered_and_opens_a_channel() {
    let mut harness = Harness::standard();
    let channel = harness.open("stream-1").await;
    assert_eq!(channel.stream_id(), "stream-1");
    assert_eq!(
        harness.validations.lock().unwrap().as_slice(),
        [("stream-1".to_owned(), "harness-authorization".to_owned())]
    );
    assert_eq!(
        harness.sent(),
        [Frame::new(
            "stream-1",
            Body::Handshake {
                payload: b"handshake-response".to_vec()
            }
        )]
    );
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn inbound_messages_are_decrypted_reordered_and_delivered_in_order() {
    let mut harness = Harness::standard();
    let channel = harness.open("stream-1").await;
    harness.message("stream-1", 2, b"third");
    harness.message("stream-1", 0, b"first");
    harness.message("stream-1", 1, b"second");
    harness.message("stream-1", 1, b"duplicate");
    assert_eq!(channel.next().await.unwrap(), b"first");
    assert_eq!(channel.next().await.unwrap(), b"second");
    assert_eq!(channel.next().await.unwrap(), b"third");
    let framed = wire::frame_message(b"split-across-records").unwrap();
    harness.data("stream-1", 3, &framed[..7]);
    harness.data("stream-1", 4, &framed[7..]);
    assert_eq!(channel.next().await.unwrap(), b"split-across-records");
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn a_duplicate_data_frame_is_consumed_exactly_once() {
    let mut harness = Harness::standard();
    let channel = harness.open("stream-1").await;
    harness.message("stream-1", 0, b"first");
    harness.message("stream-1", 0, b"first");
    harness.message("stream-1", 1, b"second");
    assert_eq!(channel.next().await.unwrap(), b"first");
    assert_eq!(channel.next().await.unwrap(), b"second");
    harness.message("stream-1", 1, b"second");
    harness.message("stream-1", 0, b"first");
    harness.message("stream-1", 2, b"third");
    assert_eq!(channel.next().await.unwrap(), b"third");
    settle().await;
    assert_eq!(harness.resets("stream-1"), 0);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn outbound_messages_are_framed_chunked_encrypted_and_sequenced() {
    let mut harness = Harness::standard();
    let channel = harness.open("stream-1").await;
    channel.send(b"hello").await.unwrap();
    let big = vec![b'x'; RECORD_PLAINTEXT_BYTES * 2];
    channel.send(&big).await.unwrap();
    let frames = harness.sent().into_iter().skip(1).collect::<Vec<_>>();
    assert_eq!(frames.len(), 1 + 3);
    let mut plaintext = Vec::new();
    for (index, frame) in frames.iter().enumerate() {
        let Body::Data {
            seq,
            segment_index,
            segment_count,
            payload,
        } = &frame.body
        else {
            panic!("not a data frame: {frame:?}")
        };
        assert_eq!(
            (*seq as usize, *segment_index, *segment_count),
            (index, 0, 1)
        );
        assert!(payload.len() <= RECORD_PLAINTEXT_BYTES);
        plaintext.extend(payload.iter().map(|byte| byte ^ 0x5a));
    }
    let mut decoder = MessageDecoder::default();
    let mut messages = Vec::new();
    for chunk in plaintext.chunks(RECORD_PLAINTEXT_BYTES) {
        messages.extend(decoder.push(chunk).unwrap());
    }
    assert_eq!(messages, [b"hello".to_vec(), big]);
    assert_eq!(channel.send(b"").await, Err(Closed));
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn a_failed_send_retires_the_stream() {
    let mut harness = Harness::standard();
    let channel = harness.open("refused").await;
    harness.refuse_output.store(true, Ordering::SeqCst);
    assert_eq!(channel.send(b"hello").await, Err(Closed));
    harness.refuse_output.store(false, Ordering::SeqCst);
    assert!(*channel.closed().borrow());
    assert_eq!(channel.next().await, None);

    let channel = harness.open("encrypt-fails").await;
    assert_eq!(channel.send(b"FAIL").await, Err(Closed));
    assert!(*channel.closed().borrow());
    eventually(|| harness.resets("encrypt-fails") == 1).await;
    assert_eq!(channel.send(b"later").await, Err(Closed));
    assert_eq!(harness.resets("encrypt-fails"), 1);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn failed_handshakes_are_reset_counted_and_cool_down_after_eight() {
    let mut harness = Harness::standard();
    *harness.fake.mode.lock().unwrap() = Mode::Fail;
    for index in 0..8 {
        harness.handshake(&format!("bad-{index}"));
        let stream = format!("bad-{index}");
        eventually(|| harness.resets(&stream) == 1).await;
    }
    *harness.fake.mode.lock().unwrap() = Mode::Accept;
    let calls = harness.fake.calls.load(Ordering::SeqCst);
    assert_eq!(calls, 8);
    harness.handshake("cooling");
    eventually(|| harness.resets("cooling") == 1).await;
    settle().await;
    assert_eq!(harness.fake.calls.load(Ordering::SeqCst), calls);
    harness.clock.advance_to(10_000);
    let channel = harness.open("recovered").await;
    assert_eq!(channel.stream_id(), "recovered");
    assert_eq!(harness.clock.wall(), WALL_BASE + 10_000);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn an_acceptance_that_never_authorized_is_rejected() {
    let mut harness = Harness::standard();
    *harness.fake.mode.lock().unwrap() = Mode::SkipAuthorize;
    harness.handshake("unauthorized");
    eventually(|| harness.resets("unauthorized") == 1).await;
    settle().await;
    assert!(harness.channels.try_recv().is_err());
    assert!(
        !harness
            .sent()
            .iter()
            .any(|frame| matches!(frame.body, Body::Handshake { .. }))
    );
    *harness.fake.mode.lock().unwrap() = Mode::Accept;
    harness.deny_validation.store(true, Ordering::SeqCst);
    harness.handshake("denied");
    eventually(|| harness.resets("denied") == 1).await;
    assert!(harness.channels.try_recv().is_err());
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn a_repeated_handshake_resets_without_disturbing_the_open_stream() {
    let mut harness = Harness::standard();
    let channel = harness.open("stream-1").await;
    harness.handshake("stream-1");
    eventually(|| harness.resets("stream-1") == 1).await;
    harness.message("stream-1", 0, b"still-open");
    assert_eq!(channel.next().await.unwrap(), b"still-open");
    assert_eq!(harness.fake.calls.load(Ordering::SeqCst), 1);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn frames_for_one_stream_are_processed_in_arrival_order() {
    let mut harness = Harness::standard();
    *harness.fake.mode.lock().unwrap() = Mode::Block;
    harness.handshake("racing");
    eventually(|| harness.fake.calls.load(Ordering::SeqCst) == 1).await;
    harness.message("racing", 0, b"queued-behind-the-handshake");
    harness.handshake("racing");
    settle().await;
    assert_eq!(harness.resets("racing"), 0);
    assert_eq!(harness.fake.calls.load(Ordering::SeqCst), 1);
    harness.fake.gate.add_permits(1000);
    let channel = tokio::time::timeout(Duration::from_secs(5), harness.channels.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        channel.next().await.unwrap(),
        b"queued-behind-the-handshake"
    );
    eventually(|| harness.resets("racing") == 1).await;
    assert!(harness.channels.try_recv().is_err());
    assert_eq!(harness.fake.calls.load(Ordering::SeqCst), 1);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn a_reset_during_validation_discards_the_pending_handshake_silently() {
    let mut harness = Harness::standard();
    harness.data("unknown", 0, b"x");
    eventually(|| harness.resets("unknown") == 1).await;
    *harness.fake.mode.lock().unwrap() = Mode::Block;
    harness.handshake("pending");
    eventually(|| harness.fake.calls.load(Ordering::SeqCst) == 1).await;
    harness.deliver(
        "pending",
        Body::Reset {
            reason: "peer".into(),
        },
    );
    harness.fake.gate.add_permits(1000);
    settle().await;
    assert!(harness.channels.try_recv().is_err());
    assert_eq!(harness.resets("pending"), 0);
    assert!(
        !harness
            .sent()
            .iter()
            .any(|frame| frame.stream_id == "pending")
    );
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn active_and_pending_stream_limits_reset_new_handshakes() {
    let mut harness = Harness::standard();
    let mut open = Vec::new();
    for index in 0..128 {
        open.push(harness.open(&format!("open-{index}")).await);
    }
    harness.handshake("one-too-many");
    eventually(|| harness.resets("one-too-many") == 1).await;
    assert!(harness.channels.try_recv().is_err());
    harness.carrier.close().await.unwrap();

    let harness = Harness::standard();
    *harness.fake.mode.lock().unwrap() = Mode::Block;
    for index in 0..32 {
        harness.handshake(&format!("pending-{index}"));
    }
    eventually(|| harness.fake.calls.load(Ordering::SeqCst) == 32).await;
    harness.handshake("pending-overflow");
    eventually(|| harness.resets("pending-overflow") == 1).await;
    assert_eq!(harness.fake.calls.load(Ordering::SeqCst), 32);
    harness.fake.gate.add_permits(1000);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn protocol_violations_close_the_stream_and_reset() {
    type Violation = (&'static str, Box<dyn Fn(&Harness)>);
    let violations: Vec<Violation> = vec![
        (
            "oversized ciphertext",
            Box::new(|harness| {
                harness.deliver(
                    "s",
                    Body::Data {
                        seq: 0,
                        segment_index: 0,
                        segment_count: 1,
                        payload: vec![0; 65_536],
                    },
                )
            }),
        ),
        (
            "reorder window",
            Box::new(|harness| harness.data("s", 65, b"x")),
        ),
        (
            "undecryptable",
            Box::new(|harness| {
                harness.deliver(
                    "s",
                    Body::Data {
                        seq: 0,
                        segment_index: 0,
                        segment_count: 1,
                        payload: vec![0xde, 0xad],
                    },
                )
            }),
        ),
        (
            "invalid length prefix",
            Box::new(|harness| harness.data("s", 0, &[0, 0, 0, 0])),
        ),
    ];
    for (name, violate) in violations {
        let mut harness = Harness::standard();
        let channel = harness.open("s").await;
        violate(&harness);
        eventually(|| harness.resets("s") == 1).await;
        assert_eq!(channel.next().await, None, "{name}");
        harness.data("s", 0, b"ignored-after-close");
        eventually(|| harness.resets("s") == 2).await;
        harness.carrier.close().await.unwrap();
    }
}

#[tokio::test]
async fn unread_messages_are_bounded_per_stream_and_across_the_carrier() {
    let mut harness = Harness::new(8, 1_000_000);
    let channel = harness.open("s").await;
    harness.message("s", 0, b"12345678");
    harness.message("s", 1, b"9");
    eventually(|| harness.resets("s") == 1).await;
    assert_eq!(channel.next().await.unwrap(), b"12345678");
    assert_eq!(channel.next().await, None);
    harness.carrier.close().await.unwrap();

    let mut harness = Harness::new(1_000_000, 10);
    let channel = harness.open("s").await;
    harness.deliver(
        "s",
        Body::Data {
            seq: 0,
            segment_index: 0,
            segment_count: 1,
            payload: vec![0; 11],
        },
    );
    eventually(|| harness.resets("s") == 1).await;
    assert_eq!(channel.next().await, None);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn a_peer_reset_closes_the_stream_without_echoing_and_allows_a_new_handshake() {
    let mut harness = Harness::standard();
    let channel = harness.open("s").await;
    harness.deliver(
        "s",
        Body::Reset {
            reason: "peer".into(),
        },
    );
    assert_eq!(channel.next().await, None);
    settle().await;
    assert_eq!(harness.resets("s"), 0);
    let reopened = harness.open("s").await;
    harness.message("s", 0, b"again");
    assert_eq!(reopened.next().await.unwrap(), b"again");
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn a_finished_consumer_retires_its_stream() {
    let mut harness = Harness::standard();
    harness.finish_immediately.store(true, Ordering::SeqCst);
    let channel = harness.open("s").await;
    eventually(|| harness.resets("s") == 1).await;
    assert!(*channel.closed().borrow());
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn queued_messages_remain_readable_after_the_stream_closes() {
    let mut harness = Harness::standard();
    let channel = harness.open("s").await;
    harness.message("s", 0, b"queued");
    settle().await;
    harness.deliver(
        "s",
        Body::Reset {
            reason: "peer".into(),
        },
    );
    assert_eq!(channel.next().await.unwrap(), b"queued");
    assert_eq!(channel.next().await, None);
    harness.carrier.close().await.unwrap();
}

#[tokio::test]
async fn closing_the_carrier_cancels_streams_and_ignores_later_frames() {
    let mut harness = Harness::standard();
    let channel = harness.open("s").await;
    let mut closed = channel.closed();
    harness.carrier.close().await.unwrap();
    assert!(*closed.borrow_and_update());
    assert_eq!(channel.next().await, None);
    let before = harness.sent().len();
    harness.handshake("late");
    harness.data("s", 0, b"x");
    settle().await;
    assert_eq!(harness.sent().len(), before);
    assert_eq!(harness.fake.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn undecodable_and_bodyless_frames_are_ignored() {
    let mut harness = Harness::standard();
    let _channel = harness.open("s").await;
    harness.carrier.handle(&[0xff, 0xff]);
    harness.carrier.handle(&[0x08, 0x02]);
    harness.deliver("s", Body::Ack);
    harness.deliver("s", Body::Heartbeat);
    harness.deliver("s", Body::Resume { next_seq: 3 });
    settle().await;
    assert_eq!(harness.sent().len(), 1);
    harness.carrier.close().await.unwrap();
}
