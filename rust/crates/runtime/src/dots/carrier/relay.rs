use super::{
    Clock,
    relay_wire::{
        self as wire, Body, Frame, MAX_CIPHERTEXT_BYTES, MessageDecoder, OrderedCiphertexts,
        RECORD_PLAINTEXT_BYTES, RESET_REASON,
    },
};

#[cfg(test)]
#[path = "relay_shutdown_tests.rs"]
mod shutdown_tests;

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::{
    sync::{Notify, watch},
    task::{Id, JoinError, JoinSet},
};
use ycoding_core::dots::noise;

pub const MAX_ACTIVE_STREAMS: usize = 128;
pub const MAX_FAILED_HANDSHAKES: u32 = 8;
pub const HANDSHAKE_FAILURE_COOLDOWN_MS: u64 = 10_000;
pub const MAX_PENDING_VALIDATIONS: usize = 32;
pub const MAX_AUTHORIZATION_BYTES: usize = 4096;
pub const DEFAULT_MAX_STREAM_QUEUED_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_MAX_CARRIER_INBOUND_BYTES: usize = 32 * 1024 * 1024;

type Boxed<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub trait Cipher: Send + Sync {
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()>;
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ()>;
}

impl Cipher for noise::Transport {
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ()> {
        noise::Transport::encrypt(self, plaintext).map_err(|_| ())
    }
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ()> {
        noise::Transport::decrypt(self, ciphertext).map_err(|_| ())
    }
}

pub type Authorize = Box<dyn FnOnce(noise::PublicKey, String) -> Boxed<Result<(), ()>> + Send>;
pub type Authorizer =
    Arc<dyn Fn(noise::PublicKey, String, String) -> Boxed<Result<(), ()>> + Send + Sync>;
pub struct Accepted {
    pub response: Vec<u8>,
    pub cipher: Arc<dyn Cipher>,
}

pub trait Acceptor: Send + Sync {
    fn accept(
        &self,
        stream_id: &str,
        request: Vec<u8>,
        authorize: Authorize,
    ) -> Boxed<Result<Accepted, ()>>;
}

pub struct NoiseAcceptor {
    pub identity: Arc<noise::Identity>,
    pub environment_id: String,
    pub registration_id: String,
}

impl Acceptor for NoiseAcceptor {
    fn accept(
        &self,
        stream_id: &str,
        request: Vec<u8>,
        authorize: Authorize,
    ) -> Boxed<Result<Accepted, ()>> {
        let identity = self.identity.clone();
        let environment_id = self.environment_id.clone();
        let registration_id = self.registration_id.clone();
        let stream_id = stream_id.to_owned();
        Box::pin(async move {
            let accepted = noise::accept_handshake(
                noise::Accept {
                    identity: &identity,
                    environment_id: &environment_id,
                    registration_id: &registration_id,
                    stream_id: &stream_id,
                    request: &request,
                },
                authorize,
            )
            .await
            .map_err(|_| ())?;
            Ok(Accepted {
                response: accepted.response,
                cipher: Arc::new(accepted.transport),
            })
        })
    }
}

pub type Output = Arc<dyn Fn(Vec<u8>) -> Result<(), ()> + Send + Sync>;
pub type OnChannel = Arc<dyn Fn(Channel) -> Boxed<()> + Send + Sync>;

pub struct Settings {
    pub acceptor: Arc<dyn Acceptor>,
    pub authorize: Authorizer,
    pub output: Output,
    pub clock: Arc<dyn Clock>,
    pub on_channel: OnChannel,
    pub max_stream_queued_bytes: usize,
    pub max_carrier_inbound_bytes: usize,
}

#[derive(Debug, Eq, PartialEq)]
pub struct Closed;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Worker {
    Queue,
    Channel,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum JoinFailure {
    Panic,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseFailure {
    pub task: u64,
    pub worker: Worker,
    pub kind: JoinFailure,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CloseFailed {
    failures: Vec<CloseFailure>,
}

impl CloseFailed {
    #[cfg(test)]
    pub fn failures(&self) -> &[CloseFailure] {
        &self.failures
    }
}

impl std::fmt::Display for CloseFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Relay close failed for {} tasks",
            self.failures.len()
        )
    }
}

impl std::error::Error for CloseFailed {}

#[derive(Default)]
struct Tasks {
    tasks: JoinSet<()>,
    next: u64,
    admitted: BTreeMap<Id, (u64, Worker)>,
    failures: BTreeMap<u64, CloseFailure>,
    result: Option<Result<(), CloseFailed>>,
}

impl Tasks {
    fn spawn(&mut self, worker: Worker, future: impl Future<Output = ()> + Send + 'static) {
        let task = self.tasks.spawn(future);
        self.admitted.insert(task.id(), (self.next, worker));
        self.next += 1;
    }

    fn record(&mut self, result: Result<(Id, ()), JoinError>) {
        match result {
            Ok((id, ())) => {
                self.admitted.remove(&id);
            }
            Err(error) => {
                let (task, worker) = self
                    .admitted
                    .remove(&error.id())
                    .expect("Relay task is owned");
                let kind = if error.is_cancelled() {
                    JoinFailure::Cancelled
                } else {
                    JoinFailure::Panic
                };
                self.failures
                    .insert(task, CloseFailure { task, worker, kind });
            }
        }
    }
}

#[derive(Default)]
struct Queue {
    messages: VecDeque<Vec<u8>>,
    bytes: usize,
}

#[derive(Default)]
struct Inbound {
    ciphertexts: OrderedCiphertexts,
    decoder: MessageDecoder,
}

struct Stream {
    instance: u64,
    cipher: Arc<dyn Cipher>,
    closed: watch::Sender<bool>,
    inbound: Mutex<Inbound>,
    queue: Mutex<Queue>,
    ready: Notify,
    outbound_seq: tokio::sync::Mutex<u32>,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Default)]
struct State {
    streams: HashMap<String, Arc<Stream>>,
    pending: HashMap<String, u64>,
    failed: u32,
    cooldown_until: Option<u64>,
    closed: bool,
    next_instance: u64,
    next_attempt: u64,
}

struct Inner {
    settings: Settings,
    state: Mutex<State>,
    queues: Mutex<HashMap<String, VecDeque<Frame>>>,
    tasks: Mutex<Tasks>,
    drain: tokio::sync::Mutex<()>,
}

pub struct Carrier {
    inner: Arc<Inner>,
}

pub struct Channel {
    stream_id: String,
    stream: Arc<Stream>,
    inner: Arc<Inner>,
}

impl Channel {
    #[cfg(test)]
    pub fn stream_id(&self) -> &str {
        &self.stream_id
    }

    pub fn closed(&self) -> watch::Receiver<bool> {
        self.stream.closed.subscribe()
    }

    pub async fn send(&self, message: &[u8]) -> Result<(), Closed> {
        let result = self.transmit(message).await;
        if result.is_err() {
            self.inner.retire(&self.stream_id, self.stream.instance);
        }
        result
    }

    async fn transmit(&self, message: &[u8]) -> Result<(), Closed> {
        if *self.stream.closed.borrow() {
            return Err(Closed);
        }
        let mut next = self.stream.outbound_seq.lock().await;
        if *self.stream.closed.borrow() {
            return Err(Closed);
        }
        let framed = wire::frame_message(message).map_err(|_| Closed)?;
        for chunk in framed.chunks(RECORD_PLAINTEXT_BYTES) {
            let seq = *next;
            if seq == u32::MAX {
                return Err(Closed);
            }
            *next += 1;
            let ciphertext = self.stream.cipher.encrypt(chunk).map_err(|_| Closed)?;
            let frame = wire::encode(&Frame::new(
                &self.stream_id,
                Body::Data {
                    seq,
                    segment_index: 0,
                    segment_count: 1,
                    payload: ciphertext,
                },
            ));
            (self.inner.settings.output)(frame).map_err(|_| Closed)?;
        }
        Ok(())
    }

    pub async fn next(&self) -> Option<Vec<u8>> {
        loop {
            let notified = self.stream.ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut queue = locked(&self.stream.queue);
                if let Some(message) = queue.messages.pop_front() {
                    queue.bytes = queue.bytes.saturating_sub(message.len());
                    return Some(message);
                }
            }
            if *self.stream.closed.borrow() {
                return None;
            }
            notified.await;
        }
    }
}

impl Carrier {
    pub fn new(settings: Settings) -> Self {
        Self {
            inner: Arc::new(Inner {
                settings,
                state: Mutex::new(State {
                    next_instance: 1,
                    next_attempt: 1,
                    ..State::default()
                }),
                queues: Mutex::new(HashMap::new()),
                tasks: Mutex::new(Tasks::default()),
                drain: tokio::sync::Mutex::new(()),
            }),
        }
    }

    pub fn handle(&self, bytes: &[u8]) {
        self.inner.handle(bytes);
    }

    pub async fn close(&self) -> Result<(), CloseFailed> {
        self.inner.shutdown();
        let _drain = self.inner.drain.lock().await;
        if let Some(result) = &locked(&self.inner.tasks).result {
            return result.clone();
        }
        loop {
            let result = std::future::poll_fn(|cx| {
                locked(&self.inner.tasks).tasks.poll_join_next_with_id(cx)
            })
            .await;
            let Some(result) = result else { break };
            locked(&self.inner.tasks).record(result);
        }
        let mut tasks = locked(&self.inner.tasks);
        let failures = tasks.failures.values().cloned().collect::<Vec<_>>();
        let result = if failures.is_empty() {
            Ok(())
        } else {
            Err(CloseFailed { failures })
        };
        tasks.result = Some(result.clone());
        result
    }
}

impl Drop for Carrier {
    fn drop(&mut self) {
        self.inner.shutdown();
        locked(&self.inner.tasks).tasks.abort_all();
    }
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        locked(&self.state)
    }

    fn is_closed(&self) -> bool {
        self.state().closed
    }

    fn reset(&self, stream_id: &str) {
        let frame = wire::encode(&Frame::new(
            stream_id,
            Body::Reset {
                reason: RESET_REASON.into(),
            },
        ));
        let _ = (self.settings.output)(frame);
    }

    fn record_failed(&self, state: &mut State) {
        if state.cooldown_until.is_some() {
            return;
        }
        state.failed += 1;
        if state.failed >= MAX_FAILED_HANDSHAKES {
            state.cooldown_until = Some(self.settings.clock.wall() + HANDSHAKE_FAILURE_COOLDOWN_MS);
        }
    }

    fn close_stream(&self, stream_id: &str, instance: Option<u64>) {
        let stream = {
            let mut state = self.state();
            match state.streams.get(stream_id) {
                Some(stream) if instance.is_none_or(|instance| stream.instance == instance) => {
                    state.streams.remove(stream_id)
                }
                _ => None,
            }
        };
        if let Some(stream) = stream {
            locked(&stream.queue).bytes = 0;
            stream.closed.send_replace(true);
            stream.ready.notify_waiters();
        }
    }

    fn retire(&self, stream_id: &str, instance: u64) {
        let current = self
            .state()
            .streams
            .get(stream_id)
            .is_some_and(|stream| stream.instance == instance);
        if !current {
            return;
        }
        self.close_stream(stream_id, Some(instance));
        self.reset(stream_id);
    }

    fn shutdown(&self) {
        let mut state = self.state();
        state.closed = true;
        state.pending.clear();
        let streams = std::mem::take(&mut state.streams);
        for stream in streams.into_values() {
            stream.closed.send_replace(true);
            *locked(&stream.queue) = Queue::default();
            *locked(&stream.inbound) = Inbound::default();
            stream.ready.notify_waiters();
        }
        locked(&self.queues).clear();
    }

    fn inbound_bytes(&self) -> usize {
        self.state()
            .streams
            .values()
            .map(|stream| {
                let inbound = locked(&stream.inbound);
                locked(&stream.queue).bytes
                    + inbound.ciphertexts.pending_bytes()
                    + inbound.decoder.buffered_bytes()
            })
            .sum()
    }

    fn handle(self: &Arc<Self>, bytes: &[u8]) {
        if self.is_closed() {
            return;
        }
        let Ok(frame) = wire::decode(bytes) else {
            return;
        };
        let state = self.state();
        if state.closed {
            return;
        }
        if matches!(frame.body, Body::Reset { .. }) {
            drop(state);
            self.state().pending.remove(&frame.stream_id);
            self.close_stream(&frame.stream_id, None);
            return;
        }
        let stream_id = frame.stream_id.clone();
        let mut queues = locked(&self.queues);
        if let Some(queue) = queues.get_mut(&stream_id) {
            queue.push_back(frame);
            return;
        }
        queues.insert(stream_id.clone(), VecDeque::from([frame]));
        drop(queues);
        let inner = self.clone();
        locked(&self.tasks).spawn(Worker::Queue, async move { inner.work(stream_id).await });
        drop(state);
    }

    async fn work(self: Arc<Self>, stream_id: String) {
        loop {
            let frame = {
                let mut queues = locked(&self.queues);
                match queues.get_mut(&stream_id).and_then(VecDeque::pop_front) {
                    Some(frame) => frame,
                    None => {
                        queues.remove(&stream_id);
                        return;
                    }
                }
            };
            if !self.is_closed() {
                self.process(frame).await;
            }
        }
    }

    async fn process(self: &Arc<Self>, frame: Frame) {
        let stream_id = frame.stream_id;
        match frame.body {
            Body::Handshake { payload } => self.handshake(&stream_id, payload).await,
            Body::Data { seq, payload, .. } => self.data(&stream_id, seq, payload),
            Body::Reset { .. } => {
                self.state().pending.remove(&stream_id);
                self.close_stream(&stream_id, None);
            }
            Body::Ack | Body::Resume { .. } | Body::Heartbeat => {}
        }
    }

    async fn handshake(self: &Arc<Self>, stream_id: &str, request: Vec<u8>) {
        enum Verdict {
            Reset,
            Reject,
            Proceed(u64),
        }
        let wall = self.settings.clock.wall();
        let verdict = {
            let mut state = self.state();
            let cooling = match state.cooldown_until {
                Some(until) if wall < until => true,
                Some(_) => {
                    state.failed = 0;
                    state.cooldown_until = None;
                    false
                }
                None => false,
            };
            if state.closed {
                return;
            }
            if cooling || state.streams.contains_key(stream_id) {
                Verdict::Reset
            } else if state.pending.remove(stream_id).is_some() {
                Verdict::Reject
            } else if state.streams.len() >= MAX_ACTIVE_STREAMS
                || state.pending.len() >= MAX_PENDING_VALIDATIONS
            {
                Verdict::Reset
            } else {
                let token = state.next_attempt;
                state.next_attempt += 1;
                state.pending.insert(stream_id.to_owned(), token);
                Verdict::Proceed(token)
            }
        };
        let token = match verdict {
            Verdict::Reset => return self.reset(stream_id),
            Verdict::Reject => {
                self.reset(stream_id);
                let mut state = self.state();
                self.record_failed(&mut state);
                return;
            }
            Verdict::Proceed(token) => token,
        };
        let authorized = Arc::new(AtomicBool::new(false));
        let authorize: Authorize = {
            let authorizer = self.settings.authorize.clone();
            let authorized = authorized.clone();
            let stream_id = stream_id.to_owned();
            Box::new(move |key, authorization| {
                Box::pin(async move {
                    if authorization.is_empty() || authorization.len() > MAX_AUTHORIZATION_BYTES {
                        return Err(());
                    }
                    authorizer(key, authorization, stream_id).await?;
                    authorized.store(true, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        let completed = self
            .settings
            .acceptor
            .accept(stream_id, request, authorize)
            .await;
        let Accepted { response, cipher } = match completed {
            Ok(completed) => completed,
            Err(()) => {
                let current = {
                    let mut state = self.state();
                    let current = state.pending.get(stream_id) == Some(&token);
                    if current {
                        state.pending.remove(stream_id);
                    }
                    current
                };
                if current {
                    self.reset(stream_id);
                    let mut state = self.state();
                    self.record_failed(&mut state);
                }
                return;
            }
        };
        {
            let state = self.state();
            if state.pending.get(stream_id) != Some(&token) || state.closed {
                return;
            }
        }
        if !authorized.load(Ordering::SeqCst) {
            self.state().pending.remove(stream_id);
            self.reset(stream_id);
            let mut state = self.state();
            self.record_failed(&mut state);
            return;
        }
        self.state().pending.remove(stream_id);
        let reply = wire::encode(&Frame::new(
            stream_id,
            Body::Handshake { payload: response },
        ));
        if (self.settings.output)(reply).is_err() {
            self.reset(stream_id);
            let mut state = self.state();
            self.record_failed(&mut state);
            return;
        }
        let (closed, _) = watch::channel(false);
        let stream = {
            let mut state = self.state();
            if state.closed {
                return;
            }
            let stream = Arc::new(Stream {
                instance: state.next_instance,
                cipher,
                closed,
                inbound: Mutex::new(Inbound::default()),
                queue: Mutex::new(Queue::default()),
                ready: Notify::new(),
                outbound_seq: tokio::sync::Mutex::new(0),
            });
            state.next_instance += 1;
            state.streams.insert(stream_id.to_owned(), stream.clone());
            stream
        };
        let channel = Channel {
            stream_id: stream_id.to_owned(),
            stream: stream.clone(),
            inner: self.clone(),
        };
        let state = self.state();
        if state.closed {
            return;
        }
        let inner = self.clone();
        let (stream_id, instance) = (stream_id.to_owned(), stream.instance);
        locked(&self.tasks).spawn(Worker::Channel, async move {
            (inner.settings.on_channel)(channel).await;
            inner.retire(&stream_id, instance);
        });
        drop(state);
    }

    fn data(self: &Arc<Self>, stream_id: &str, seq: u32, payload: Vec<u8>) {
        let stream = self.state().streams.get(stream_id).cloned();
        let Some(stream) = stream else {
            let mut state = self.state();
            if state.pending.remove(stream_id).is_some() {
                self.record_failed(&mut state);
            }
            drop(state);
            return self.reset(stream_id);
        };
        let fail = || {
            self.close_stream(stream_id, Some(stream.instance));
            self.reset(stream_id);
        };
        if payload.len() > MAX_CIPHERTEXT_BYTES
            || self.inbound_bytes() + payload.len() > self.settings.max_carrier_inbound_bytes
        {
            return fail();
        }
        let ready = {
            let mut inbound = locked(&stream.inbound);
            if *stream.closed.borrow() {
                return;
            }
            inbound.ciphertexts.push(seq, payload)
        };
        let Ok(ready) = ready else {
            return fail();
        };
        let current = || {
            self.state()
                .streams
                .get(stream_id)
                .is_some_and(|current| Arc::ptr_eq(current, &stream))
        };
        for ciphertext in ready {
            if !current() {
                return;
            }
            let Ok(plaintext) = stream.cipher.decrypt(&ciphertext) else {
                return fail();
            };
            if !current() {
                return;
            }
            let messages = {
                let mut inbound = locked(&stream.inbound);
                if *stream.closed.borrow() {
                    return;
                }
                inbound.decoder.push(&plaintext)
            };
            let Ok(messages) = messages else {
                return fail();
            };
            for message in messages {
                if !current() {
                    return;
                }
                let mut queue = locked(&stream.queue);
                if *stream.closed.borrow() {
                    return;
                }
                if queue.bytes + message.len() > self.settings.max_stream_queued_bytes {
                    drop(queue);
                    return fail();
                }
                queue.bytes += message.len();
                queue.messages.push_back(message);
                drop(queue);
                stream.ready.notify_waiters();
            }
        }
    }
}
