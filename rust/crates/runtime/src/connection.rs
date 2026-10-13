mod event_streams;

use crate::{
    convert,
    dispatch::{Boxed, Bulk, Settled},
    log,
    server::Shared,
};
use axum::extract::ws::{self, WebSocket};
use prost::{Message, Name};
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    runtime::Handle,
    sync::{Notify, mpsc, watch},
    task::AbortHandle,
    time::{MissedTickBehavior, interval, timeout},
};
use ycoding_core::event_feed::Subscriber;
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, LosslessString, session};
use ycoding_protocol::{
    connection::{Close, Config, Connection, Decision, EventMetadata, ProtocolError},
    decode_strict, limits, v5,
};

const TICK: Duration = Duration::from_millis(10);
const LOG_PAGE: usize = 64;

struct Inflight {
    cancelled: Arc<AtomicBool>,
    abort: Option<AbortHandle>,
}

struct Transfer {
    bulk: Bulk,
    transfer_id: String,
    started: bool,
    offset: usize,
    index: u32,
}

enum Progress {
    Blocked,
    Done,
    Live,
    Failed(ProtocolError),
}

struct PendingLog {
    session: session::Id,
    after: Option<i64>,
    follow: bool,
    scope: v5::Scope,
}

struct LiveSub {
    request_id: String,
    sub_id: String,
    session: session::Id,
    scope: v5::Scope,
    next: Option<i64>,
    follow: bool,
    accepted: bool,
    result_handed: bool,
    hydrated: bool,
    dirty: bool,
    last_created_ms: i64,
}

fn durable_aggregate(scope: &v5::Scope, sub_id: &str) -> String {
    match &scope.target {
        Some(v5::scope::Target::Session(session)) => session.clone(),
        _ => sub_id.into(),
    }
}

struct Lanes {
    runtime: Handle,
    senders: HashMap<Option<String>, mpsc::UnboundedSender<Boxed<()>>>,
}

impl Lanes {
    fn submit(&mut self, key: Option<String>, job: Boxed<()>) {
        let runtime = &self.runtime;
        let sender = self.senders.entry(key).or_insert_with(|| {
            let (sender, mut receiver) = mpsc::unbounded_channel::<Boxed<()>>();
            runtime.spawn(async move {
                while let Some(job) = receiver.recv().await {
                    job.await;
                }
            });
            sender
        });
        let _ = sender.send(job);
    }
}

struct Driver {
    connection: Connection,
    shared: Arc<Shared>,
    epoch: String,
    started: Instant,
    inflight: HashMap<String, Inflight>,
    lanes: Lanes,
    completions: mpsc::Sender<(String, Option<Settled>)>,
    runtime: Handle,
    close: Option<Close>,
    transfers: VecDeque<Transfer>,
    next_transfer: u64,
    pending_logs: HashMap<String, PendingLog>,
    subs: Vec<LiveSub>,
    pending_events: HashMap<String, v5::Scope>,
    streams: Vec<event_streams::Stream>,
    follow: Option<Subscriber>,
    wake: Arc<Notify>,
}

pub(crate) async fn run(
    mut socket: WebSocket,
    shared: Arc<Shared>,
    mut shutdown: watch::Receiver<bool>,
) {
    let epoch = shared.next_epoch();
    let config = Config {
        local_role: v5::PeerRole::Server,
        peer_role: v5::PeerRole::LocalClient,
        source_epoch: shared.environment.services.identity.source_epoch.clone(),
        connection_epoch: epoch.clone(),
        budgets: shared.environment.services.budgets.clone(),
        authorized_sessions: BTreeSet::new(),
        authorized_workspaces: BTreeSet::new(),
        reservation: None,
        event_types: BTreeSet::from(["ycoding.v5.SessionLogItem".into()]),
    };
    let Ok(connection) = Connection::new(config, shared.dispatcher.descriptors(), 0) else {
        return;
    };
    let delivery_timeout =
        Duration::from_millis(shared.environment.services.budgets.delivery_timeout_ms);
    let (completions, mut results) = mpsc::channel(limits::PENDING_REQUESTS as usize * 2);
    let runtime = Handle::current();
    let mut driver = Driver {
        connection,
        shared,
        epoch,
        started: Instant::now(),
        inflight: HashMap::new(),
        lanes: Lanes {
            runtime: runtime.clone(),
            senders: HashMap::new(),
        },
        completions,
        runtime,
        close: None,
        transfers: VecDeque::new(),
        next_transfer: 1,
        pending_logs: HashMap::new(),
        subs: Vec::new(),
        pending_events: HashMap::new(),
        streams: Vec::new(),
        follow: None,
        wake: Arc::new(Notify::new()),
    };
    let wake = driver.wake.clone();
    let mut ticker = interval(TICK);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        for frame in driver.pump() {
            if !send(
                &mut socket,
                ws::Message::Binary(frame.into()),
                delivery_timeout,
            )
            .await
            {
                return;
            }
        }
        if let Some(close) = driver.close.take() {
            tracing::debug!(
                code = close.code,
                reason = close.reason(),
                "closing v5 connection"
            );
            send(
                &mut socket,
                ws::Message::Close(Some(ws::CloseFrame {
                    code: close.code,
                    reason: close.reason().into(),
                })),
                delivery_timeout,
            )
            .await;
            break;
        }
        tokio::select! {
            message = socket.recv() => match message {
                None | Some(Err(_)) | Some(Ok(ws::Message::Close(_))) => break,
                Some(Ok(ws::Message::Binary(bytes))) => driver.receive(&bytes),
                Some(Ok(ws::Message::Text(text))) => driver.reject(text.len()),
                Some(Ok(ws::Message::Ping(_) | ws::Message::Pong(_))) => {}
            },
            Some((request_id, result)) = results.recv() => driver.complete(request_id, result),
            _ = wake.notified() => {}
            _ = ticker.tick() => {}
            _ = shutdown.changed() => driver.fail_with(Close { code: 1012, category: ProtocolError::Closed }),
        }
    }
}

async fn send(socket: &mut WebSocket, message: ws::Message, bound: Duration) -> bool {
    timeout(bound, socket.send(message))
        .await
        .is_ok_and(|result| result.is_ok())
}

impl Driver {
    fn now(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn pump(&mut self) -> Vec<Vec<u8>> {
        let mut frames = Vec::new();
        while self.close.is_none() {
            self.feed_transfers();
            self.feed_subs();
            self.feed_streams();
            let now = self.now();
            let Some(prepared) = self.connection.prepare_handoff(now) else {
                break;
            };
            let bytes = prepared.frame().encode_to_vec();
            match self.connection.handoff(prepared, bytes.len() as u64, now) {
                Ok(decisions) => {
                    let sent = decisions
                        .iter()
                        .any(|decision| matches!(decision, Decision::Send(_)));
                    self.note_handed(&decisions);
                    self.apply(decisions, None);
                    if sent {
                        frames.push(bytes);
                    }
                }
                Err(error) => self.fail(error),
            }
        }
        let notifications = self.connection.take_decisions();
        self.apply(notifications, None);
        frames
    }

    fn receive(&mut self, bytes: &[u8]) {
        let now = self.now();
        let Some(token) = self.connection.admit_incoming(bytes.len() as u64) else {
            return self.refused();
        };
        let Ok(frame) = decode_strict::<v5::Frame>(bytes) else {
            return match self.connection.reject_incoming(&token) {
                Ok(decisions) => self.apply(decisions, None),
                Err(error) => self.fail(error),
            };
        };
        let ordinal = frame.delivery_ordinal;
        match self.connection.accept_incoming(&token, frame, now) {
            Ok(decisions) => self.apply(decisions, ordinal),
            Err(error) => self.fail(error),
        }
    }

    fn reject(&mut self, length: usize) {
        let Some(token) = self.connection.admit_incoming(length as u64) else {
            return self.refused();
        };
        match self.connection.reject_incoming(&token) {
            Ok(decisions) => self.apply(decisions, None),
            Err(error) => self.fail(error),
        }
    }

    fn refused(&mut self) {
        let decisions = self.connection.take_decisions();
        self.apply(decisions, None);
        if self.close.is_none() {
            self.fail(ProtocolError::Limit);
        }
    }

    fn apply(&mut self, decisions: Vec<Decision>, ordinal: Option<u64>) {
        for decision in decisions {
            match decision {
                Decision::Send(_) | Decision::Established => {}
                Decision::Request(request) => {
                    self.consume(ordinal);
                    self.dispatch(request);
                }
                Decision::Control(_) => self.consume(ordinal),
                Decision::CancelWork { target, mutation } => self.cancel(&target, mutation),
                Decision::Closed(close) => self.fail_with(close),
                _ => self.fail(ProtocolError::Direction),
            }
        }
    }

    fn consume(&mut self, ordinal: Option<u64>) {
        let Some(ordinal) = ordinal else {
            return self.fail(ProtocolError::Malformed);
        };
        let now = self.now();
        if let Err(error) = self
            .connection
            .consume(v5::LedgerClass::Normal, ordinal, now)
        {
            self.fail(error);
        }
    }

    fn dispatch(&mut self, request: v5::Request) {
        let shared = self.shared.clone();
        let Some(mutation) = shared
            .dispatcher
            .descriptor(request.operation_id)
            .map(|descriptor| descriptor.mutation == v5::MutationClass::Mutation as i32)
        else {
            return self.fail(ProtocolError::Malformed);
        };
        let lane = match &request.scope.target {
            Some(v5::scope::Target::Session(id)) => Some(id.clone()),
            _ => None,
        };
        let request_id = request.request_id.clone();
        let stashed = stash_log(&shared, &request);
        if let Some(scope) = stash_events(&shared, &request) {
            self.pending_events
                .insert(request.request_id.clone(), scope);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = {
            let completions = self.completions.clone();
            let cancelled = cancelled.clone();
            let connection_id = self.epoch.clone();
            async move {
                if cancelled.load(Ordering::Acquire) {
                    return;
                }
                let environment = shared.environment.clone();
                let request_id = request.request_id.clone();
                let result = shared
                    .dispatcher
                    .invoke(environment, connection_id, request)
                    .await;
                let _ = completions.send((request_id, result)).await;
            }
        };
        let abort = if mutation {
            self.lanes.submit(lane, Box::pin(job));
            None
        } else {
            Some(self.runtime.spawn(job).abort_handle())
        };
        if let Some(stashed) = stashed {
            self.pending_logs.insert(request_id.clone(), stashed);
        }
        self.inflight
            .insert(request_id, Inflight { cancelled, abort });
    }

    fn cancel(&mut self, target: &v5::cancel::Target, mutation: bool) {
        self.transfers.retain(|transfer| match target {
            v5::cancel::Target::RequestId(id) => &transfer.bulk.request_id != id,
            v5::cancel::Target::TransferId(id) => &transfer.transfer_id != id,
        });
        let v5::cancel::Target::RequestId(request_id) = target else {
            return;
        };
        self.pending_logs.remove(request_id);
        self.pending_events.remove(request_id);
        let Some(inflight) = self.inflight.remove(request_id) else {
            return;
        };
        inflight.cancelled.store(true, Ordering::Release);
        if !mutation && let Some(abort) = inflight.abort {
            abort.abort();
        }
    }

    fn complete(&mut self, request_id: String, settled: Option<Settled>) {
        if self.inflight.remove(&request_id).is_none() {
            return;
        }
        match settled {
            None => self.fail(ProtocolError::Direction),
            Some(Settled::Bulk(bulk)) => {
                let transfer_id = format!("t{}", self.next_transfer);
                self.next_transfer += 1;
                self.transfers.push_back(Transfer {
                    bulk,
                    transfer_id,
                    started: false,
                    offset: 0,
                    index: 0,
                });
            }
            Some(Settled::Result(result)) => {
                let reserve = self.reserve(
                    v5::LedgerClass::Normal,
                    v5::frame::Body::Result(result.clone()),
                );
                let now = self.now();
                match self.connection.respond(result.clone(), reserve, now) {
                    Ok(()) => self.subscribe(request_id, &result),
                    Err(ProtocolError::Unknown) => {}
                    Err(error) => self.fail(error),
                }
            }
        }
    }

    fn reserve(&self, ledger: v5::LedgerClass, body: v5::frame::Body) -> u64 {
        v5::Frame {
            revision: 5,
            connection_epoch: Some(self.epoch.clone()),
            ledger: Some(ledger as i32),
            delivery_ordinal: Some(u64::MAX),
            tiny_consumed_through: Some(u64::MAX),
            body: Some(body),
        }
        .encoded_len() as u64
    }

    fn feed_transfers(&mut self) {
        let mut position = 0;
        while position < self.transfers.len() && self.close.is_none() {
            match self.advance_transfer(position) {
                Progress::Blocked | Progress::Live => position += 1,
                Progress::Done => {
                    self.transfers.remove(position);
                }
                Progress::Failed(error) => self.fail(error),
            }
        }
    }

    fn advance_transfer(&mut self, position: usize) -> Progress {
        let piece_bytes = limits::BULK_PIECE_BYTES as usize;
        loop {
            let now = self.now();
            let transfer = &self.transfers[position];
            let length = transfer.bulk.body.len();
            let (ledger, body) = if !transfer.started {
                (
                    v5::LedgerClass::Normal,
                    v5::frame::Body::BulkStart(v5::BulkStart {
                        request_id: transfer.bulk.request_id.clone(),
                        transfer_id: transfer.transfer_id.clone(),
                        operation_id: transfer.bulk.operation_id,
                        type_name: transfer.bulk.type_name.clone(),
                        content_kind: v5::ContentKind::TypedMessage as i32,
                        byte_count: length as u64,
                        chunk_count: length.div_ceil(piece_bytes) as u32,
                    }),
                )
            } else if transfer.offset < length {
                let end = (transfer.offset + piece_bytes).min(length);
                (
                    v5::LedgerClass::Bulk,
                    v5::frame::Body::BulkPiece(v5::BulkPiece {
                        transfer_id: transfer.transfer_id.clone(),
                        index: transfer.index,
                        offset: transfer.offset as u64,
                        data: transfer.bulk.body[transfer.offset..end].to_vec(),
                    }),
                )
            } else {
                (
                    v5::LedgerClass::Normal,
                    v5::frame::Body::BulkEnd(v5::BulkEnd {
                        transfer_id: transfer.transfer_id.clone(),
                        byte_count: length as u64,
                        outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
                    }),
                )
            };
            let ending = matches!(body, v5::frame::Body::BulkEnd(_));
            let reserved = self.reserve(ledger, body.clone());
            match self.connection.enqueue(body, reserved, now) {
                Ok(()) if ending => return Progress::Done,
                Ok(()) => {
                    let transfer = &mut self.transfers[position];
                    if transfer.started {
                        transfer.offset = (transfer.offset + piece_bytes).min(length);
                        transfer.index += 1;
                    }
                    transfer.started = true;
                }
                Err(ProtocolError::Limit) => return Progress::Blocked,
                Err(error) => return Progress::Failed(error),
            }
        }
    }

    fn subscribe(&mut self, request_id: String, result: &v5::Result) {
        if Some(result.operation_id) == self.shared.dispatcher.operation_id("event.subscribe") {
            return self.open_event_stream(request_id, result);
        }
        if Some(result.operation_id) != self.shared.dispatcher.operation_id("session.log") {
            return;
        }
        let params = self.pending_logs.remove(&request_id);
        let Some(v5::result::Outcome::Success(payload)) = &result.outcome else {
            return;
        };
        let Ok(answer) = v5::SessionLogResult::decode(payload.payload.as_slice()) else {
            return;
        };
        let Ok(sub) = convert::domain(&answer.subscription_id)
            .map_err(|_| ())
            .and_then(|id| id.to_utf8().map_err(|_| ()))
        else {
            return;
        };
        let Some(params) = params else {
            return;
        };
        self.shared
            .environment
            .subscriptions
            .arm(&self.epoch, sub.clone());
        if params.follow {
            self.ensure_follow_feed();
        }
        self.subs.push(LiveSub {
            request_id,
            sub_id: sub,
            session: params.session,
            scope: params.scope,
            next: params.after,
            follow: params.follow,
            accepted: false,
            result_handed: false,
            hydrated: false,
            dirty: true,
            last_created_ms: 0,
        });
    }

    fn note_handed(&mut self, decisions: &[Decision]) {
        for decision in decisions {
            let Decision::Send(frame) = decision else {
                continue;
            };
            let Some(v5::frame::Body::Result(result)) = &frame.body else {
                continue;
            };
            for sub in self.subs.iter_mut() {
                if sub.request_id == result.request_id {
                    sub.result_handed = true;
                }
            }
            self.note_stream_handed(&result.request_id);
        }
    }

    fn feed_subs(&mut self) {
        self.drain_follow_feed();
        let mut position = 0;
        while position < self.subs.len() && self.close.is_none() {
            match self.advance_sub(position) {
                Progress::Blocked | Progress::Live => position += 1,
                Progress::Done => {
                    self.subs.remove(position);
                }
                Progress::Failed(error) => self.fail_with(Close {
                    code: 1002,
                    category: error,
                }),
            }
        }
    }

    fn advance_sub(&mut self, position: usize) -> Progress {
        if self
            .shared
            .environment
            .subscriptions
            .ended(&self.epoch, &self.subs[position].sub_id)
            == Some(true)
        {
            return self.end_sub(position);
        }
        if !self.subs[position].accepted {
            if !self.subs[position].result_handed {
                return Progress::Blocked;
            }
            let (request_id, sub_id, scope) = {
                let sub = &self.subs[position];
                (
                    sub.request_id.clone(),
                    sub.sub_id.clone(),
                    sub.scope.clone(),
                )
            };
            match self.accept_stream(&request_id, &sub_id, &scope) {
                Ok(true) => self.subs[position].accepted = true,
                Ok(false) => return Progress::Blocked,
                Err(error) => return Progress::Failed(error),
            }
        }
        let (hydrated, follow, dirty) = {
            let sub = &self.subs[position];
            (sub.hydrated, sub.follow, sub.dirty)
        };
        if hydrated && !(follow && dirty) {
            return Progress::Live;
        }
        self.subs[position].dirty = false;
        let progress = self.emit_page(position);
        if matches!(progress, Progress::Blocked) {
            self.subs[position].dirty = true;
        }
        progress
    }

    fn emit_page(&mut self, position: usize) -> Progress {
        let (session, scope, sub_id, next, follow) = {
            let sub = &self.subs[position];
            (
                sub.session.clone(),
                sub.scope.clone(),
                sub.sub_id.clone(),
                sub.next,
                sub.follow,
            )
        };
        let Some(core) = &self.shared.environment.services.core else {
            return Progress::Failed(ProtocolError::Closed);
        };
        let page = match core.sessions.log(&session, next, LOG_PAGE) {
            Ok(page) => page,
            Err(ycoding_core::ycoding_store::Error::Domain {
                kind: "not_found", ..
            }) => {
                return self.end_sub(position);
            }
            Err(_) => return Progress::Failed(ProtocolError::Closed),
        };
        for entry in &page.events {
            let versioned = format!(
                "{}.{}",
                entry.event.0.event_type.as_str().unwrap_or(""),
                entry.version
            );
            if log::excluded(&versioned) {
                self.subs[position].next = Some(entry.seq);
                continue;
            }
            let record = match log::record(entry, &session, &self.source_epoch()) {
                Ok(record) => record,
                Err(error) => {
                    tracing::warn!(event_type = ?entry.event.0.event_type.as_str(), reason = error.0, "rejecting unrepresentable session log event");
                    return Progress::Failed(ProtocolError::Malformed);
                }
            };
            match self.emit(&scope, &sub_id, &record) {
                Ok(()) => {
                    self.subs[position].next = Some(entry.seq);
                    self.subs[position].last_created_ms = record.created_ms;
                }
                Err(ProtocolError::Limit) => return Progress::Blocked,
                Err(error) => return Progress::Failed(error),
            }
        }
        if page.events.len() >= LOG_PAGE {
            self.subs[position].dirty = true;
            return Progress::Live;
        }
        self.subs[position].hydrated = true;
        let watermark = page.watermark;
        let created_ms = self.subs[position].last_created_ms;
        match self.emit_synced(&scope, &sub_id, &session, watermark, created_ms) {
            Ok(()) => {}
            Err(ProtocolError::Limit) => return Progress::Blocked,
            Err(error) => return Progress::Failed(error),
        }
        if follow {
            return Progress::Live;
        }
        self.end_sub(position)
    }

    fn emit(
        &mut self,
        scope: &v5::Scope,
        sub_id: &str,
        record: &log::Record,
    ) -> Result<(), ProtocolError> {
        let now = self.now();
        self.connection.enqueue_event(
            v5::EventRecord {
                event_id: record.event_id.clone(),
                created_ms: record.created_ms,
                durable: Some(v5::DurablePosition {
                    aggregate_id: durable_aggregate(scope, sub_id),
                    sequence: record.seq,
                    version: record.version,
                }),
                event: v5::TypedPayload {
                    type_name: v5::SessionLogItem::full_name(),
                    payload: record.item.encode_to_vec(),
                },
            },
            EventMetadata {
                subscription_id: sub_id.into(),
                scope: scope.clone(),
                source_epoch: self
                    .shared
                    .environment
                    .services
                    .identity
                    .source_epoch
                    .clone(),
                message_id: None,
                priority: v5::PriorityMode::Interactive,
            },
            now,
        )
    }

    fn emit_synced(
        &mut self,
        scope: &v5::Scope,
        sub_id: &str,
        session: &session::Id,
        watermark: Option<i64>,
        created_ms: i64,
    ) -> Result<(), ProtocolError> {
        let item = log::synced(session, watermark, &self.source_epoch());
        let now = self.now();
        self.connection.enqueue_event(
            v5::EventRecord {
                event_id: format!("log-synced-{}", watermark.unwrap_or(-1)),
                created_ms,
                durable: Some(v5::DurablePosition {
                    aggregate_id: durable_aggregate(scope, sub_id),
                    sequence: watermark.map(|watermark| watermark as u64).unwrap_or(0),
                    version: 1,
                }),
                event: v5::TypedPayload {
                    type_name: v5::SessionLogItem::full_name(),
                    payload: item.encode_to_vec(),
                },
            },
            EventMetadata {
                subscription_id: sub_id.into(),
                scope: scope.clone(),
                source_epoch: self
                    .shared
                    .environment
                    .services
                    .identity
                    .source_epoch
                    .clone(),
                message_id: None,
                priority: v5::PriorityMode::Interactive,
            },
            now,
        )
    }

    fn end_sub(&mut self, position: usize) -> Progress {
        let sub_id = self.subs[position].sub_id.clone();
        self.end_stream(&sub_id)
    }

    fn source_epoch(&self) -> LosslessString {
        LosslessString::from(
            self.shared
                .environment
                .services
                .identity
                .source_epoch
                .as_str(),
        )
    }

    fn fail(&mut self, error: ProtocolError) {
        self.fail_with(Close {
            code: 1008,
            category: error,
        });
    }

    fn fail_with(&mut self, close: Close) {
        self.close.get_or_insert(close);
    }

    fn finish(&mut self) {
        for (_, inflight) in self.inflight.drain() {
            inflight.cancelled.store(true, Ordering::Release);
            if let Some(abort) = inflight.abort {
                abort.abort();
            }
        }
        self.pending_logs.clear();
        self.pending_events.clear();
        self.shared.environment.subscriptions.release(&self.epoch);
        self.subs.clear();
        self.streams.clear();
        self.follow = None;
    }
}

impl Drop for Driver {
    fn drop(&mut self) {
        self.finish();
    }
}

fn stash_log(shared: &Arc<Shared>, request: &v5::Request) -> Option<PendingLog> {
    let descriptor = shared.dispatcher.descriptor(request.operation_id)?;
    if descriptor.diagnostic_name != "session.log" {
        return None;
    }
    let query = decode_strict::<v5::SessionLogRequest>(&request.payload).ok()?;
    let session = convert::domain(&query.params.session_id)
        .ok()
        .and_then(|id| session::Id::decode(&JsonValue::String(id)).ok())?;
    let after = query.query.after.map(|after| after as i64);
    if after.is_some_and(|after| !(0..=9_007_199_254_740_991).contains(&after)) {
        return None;
    }
    Some(PendingLog {
        session,
        after,
        follow: query.query.follow.unwrap_or(false),
        scope: request.scope.clone(),
    })
}

fn stash_events(shared: &Arc<Shared>, request: &v5::Request) -> Option<v5::Scope> {
    let descriptor = shared.dispatcher.descriptor(request.operation_id)?;
    if descriptor.diagnostic_name != "event.subscribe" {
        return None;
    }
    decode_strict::<v5::EventSubscribeRequest>(&request.payload)
        .ok()
        .map(|query| query.scope)
}
