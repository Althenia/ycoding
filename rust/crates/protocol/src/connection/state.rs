use super::{
    Budgets, Ledger, ReservationBudget, SharedReservation, event_reservation_bytes, events,
};
use crate::{limits, v5};
use prost::Message;
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::{cell::RefCell, rc::Rc};

mod boundary;
pub use boundary::{Direction, Incoming, Prepared};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolError {
    Malformed,
    Incompatible,
    Limit,
    Direction,
    Epoch,
    Closed,
    Clock,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Close {
    pub code: u16,
    pub category: ProtocolError,
}

impl Close {
    pub fn reason(&self) -> &'static str {
        match self.category {
            ProtocolError::Malformed => "malformed",
            ProtocolError::Incompatible => "incompatible",
            ProtocolError::Limit => "limit",
            ProtocolError::Direction => "direction",
            ProtocolError::Epoch => "epoch",
            ProtocolError::Closed => "closed",
            ProtocolError::Clock => "clock",
            ProtocolError::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Stats {
    pub dropped_transfers: u64,
    pub oversized_invalidations: u64,
    pub retained_bytes: u64,
    pub admitted_bytes: u64,
    pub prepared_bytes: u64,
    pub queued_bytes: [u64; 4],
    pub handed_bytes: [u64; 4],
    pub received_bytes: [u64; 4],
    pub hydration_bytes: u64,
    pub reassembly_reserved_bytes: u64,
    pub reassembly_received_bytes: u64,
    pub pending_requests: usize,
    pub subscriptions: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Unsent,
    Unknown,
    Success {
        settlement: v5::Settlement,
        payload: v5::TypedPayload,
    },
    Rejected(v5::TypedPayload),
    BulkSuccess {
        settlement: v5::Settlement,
        start: v5::BulkStart,
        bytes: Rc<Vec<u8>>,
    },
    AssetSuccess {
        settlement: v5::Settlement,
        metadata: Rc<v5::AssetMetadataResult>,
        start: v5::BulkStart,
        bytes: Rc<Vec<u8>>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Send(v5::Frame),
    Established,
    AssetMetadata {
        request_id: String,
        metadata: Rc<v5::AssetMetadataResult>,
    },
    EventBatchReleased {
        ticket: u64,
        consumed: bool,
    },
    Request(v5::Request),
    Settled {
        request_id: String,
        outcome: Outcome,
    },
    CancelWork {
        target: v5::cancel::Target,
        mutation: bool,
    },
    Events(v5::EventBatch),
    Control(v5::Control),
    Forward(v5::Frame),
    Resync(v5::ResyncRequired),
    StreamComplete(String),
    Closed(Close),
}

#[derive(Debug, Clone)]
pub struct Config {
    pub local_role: v5::PeerRole,
    pub peer_role: v5::PeerRole,
    pub source_epoch: String,
    pub connection_epoch: String,
    pub budgets: Budgets,
    pub authorized_sessions: BTreeSet<String>,
    pub authorized_workspaces: BTreeSet<String>,
    pub reservation: Option<SharedReservation>,
    pub event_types: BTreeSet<String>,
}

#[derive(Debug, Clone)]
pub struct EventMetadata {
    pub subscription_id: String,
    pub scope: v5::Scope,
    pub source_epoch: String,
    pub message_id: Option<String>,
    pub priority: v5::PriorityMode,
}
#[derive(Debug, PartialEq)]
pub struct RelayInterestDelta {
    pub added: Vec<String>,
    pub removed: Vec<String>,
}

pub struct Connection {
    config: Config,
    reservation: SharedReservation,
    descriptors: Vec<v5::OperationDescriptor>,
    owner: Rc<()>,
    owned_charge: u64,
    authority_version: u64,
    next_token: u64,
    admissions: BTreeMap<u64, (u64, u64)>,
    prepared: Option<boundary::PreparedState>,
    notifications: Vec<Decision>,
    hello_handed: bool,
    ready_handed: bool,
    now: u64,
    phase: Phase,
    deadline: u64,
    epoch: String,
    source_epoch: String,
    send: [Ledger; 4],
    receive: [ReceiveLedger; 4],
    queues: [VecDeque<Queued>; 4],
    queued_bytes: [u64; 4],
    requests: BTreeMap<String, Pending>,
    incoming: BTreeMap<String, Pending>,
    next_request: u64,
    subscriptions: BTreeMap<String, Subscription>,
    awaiting_subscription: BTreeMap<String, Pending>,
    sending_subscriptions: BTreeMap<String, Subscription>,
    relay_clients: BTreeMap<String, (v5::SubscriptionSnapshot, u64)>,
    relay_identities: BTreeMap<String, (String, u64)>,
    forwarded_tickets: BTreeSet<u64>,
    resync_fences: BTreeMap<u64, v5::Scope>,
    event_ticket: u64,
    handed_events: BTreeMap<u64, (u64, String)>,
    oversized_invalidations: u64,
    dropped_transfers: u64,
    transfers: BTreeMap<String, Transfer>,
    outgoing_transfers: BTreeMap<String, Transfer>,
    ping: Option<u64>,
    next_ping: u64,
    last_ping: Option<u64>,
    peer_ping: Option<u64>,
    tiny_rates: [VecDeque<(u64, u64)>; 2],
    normal_rates: [VecDeque<(u64, u64)>; 2],
    event_rotation: Option<String>,
    bulk_rotation: Option<String>,
    event_weight: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Initial,
    Hello,
    Confirm,
    Established,
    Closed,
}

#[derive(Default)]
struct ReceiveLedger {
    last: u64,
    consumed: u64,
    bytes: BTreeMap<u64, Received>,
    pending_bytes: u64,
    pending_since: Option<u64>,
}

struct Received {
    bytes: u64,
    consumed: bool,
    charge: u64,
}

struct Queued {
    frame: v5::Frame,
    bytes: u64,
    ready_at: u64,
    ticket: Option<u64>,
    event_fence: Option<u64>,
    event_key: Option<String>,
}

#[derive(Clone, Default)]
struct Pending {
    operation_id: u32,
    scope: v5::Scope,
    sent: bool,
    asset_count: Option<u64>,
    asset_metadata: Option<Rc<v5::AssetMetadataResult>>,
    asset_charge: u64,
}

struct Subscription {
    event_types: Vec<String>,
    scope: v5::Scope,
    source_epoch: Option<String>,
    hydration: Option<VecDeque<(v5::EventBatch, u64)>>,
    bytes: u64,
    events: usize,
    invalidated: bool,
    ending: bool,
    resync_required: bool,
}

struct Transfer {
    start: v5::BulkStart,
    index: u32,
    received: u64,
    bytes: Rc<Vec<u8>>,
    complete: bool,
    started: bool,
    handed_pieces: u32,
    asset_metadata: Option<Rc<v5::AssetMetadataResult>>,
    asset_charge: u64,
}

impl Connection {
    pub fn reservation(&self) -> SharedReservation {
        self.reservation.clone()
    }
    pub fn relay_subscription_id(&self, session_id: &str) -> Option<&str> {
        self.relay_identities
            .get(session_id)
            .map(|(id, _)| id.as_str())
    }
    pub fn relay_interest_retained_bytes(&self) -> u64 {
        self.relay_clients
            .values()
            .map(|(_, bytes)| *bytes)
            .chain(self.relay_identities.values().map(|(_, bytes)| *bytes))
            .sum()
    }
    pub fn update_relay_interests(
        &mut self,
        snapshot: v5::SubscriptionSnapshot,
        now_ms: u64,
    ) -> Result<RelayInterestDelta, ProtocolError> {
        self.time(now_ms)?;
        if self.phase != Phase::Established
            || self.config.local_role != v5::PeerRole::Agent
            || self.config.peer_role != v5::PeerRole::Relay
        {
            return Err(ProtocolError::Direction);
        }
        if snapshot.client_id.is_empty()
            || snapshot.session_ids.iter().any(String::is_empty)
            || snapshot.session_ids.iter().collect::<BTreeSet<_>>().len()
                != snapshot.session_ids.len()
        {
            return Err(ProtocolError::Malformed);
        }
        let before = self
            .relay_clients
            .values()
            .flat_map(|(entry, _)| entry.session_ids.iter().map(String::as_str))
            .collect::<BTreeSet<_>>();
        let after = self
            .relay_clients
            .iter()
            .filter(|(id, _)| *id != &snapshot.client_id)
            .flat_map(|(_, (entry, _))| entry.session_ids.iter().map(String::as_str))
            .chain(snapshot.session_ids.iter().map(String::as_str))
            .collect::<BTreeSet<_>>();
        if snapshot.session_ids.len() > limits::SUBSCRIPTIONS as usize
            || after.len() > limits::SUBSCRIPTIONS as usize
            || (!snapshot.session_ids.is_empty()
                && !self.relay_clients.contains_key(&snapshot.client_id)
                && self.relay_clients.len() >= limits::RELAY_PEERS as usize)
            || snapshot.encoded_len() as u64 > limits::SERVER_FRAME_BYTES
        {
            return Err(ProtocolError::Limit);
        }
        let delta = RelayInterestDelta {
            added: after
                .difference(&before)
                .map(|id| (*id).to_string())
                .collect(),
            removed: before
                .difference(&after)
                .map(|id| (*id).to_string())
                .collect(),
        };
        let bytes = snapshot.encoded_len() as u64;
        if !snapshot.session_ids.is_empty() && !self.reserve(bytes) {
            return Err(ProtocolError::Limit);
        }
        let previous = if snapshot.session_ids.is_empty() {
            self.relay_clients.remove(&snapshot.client_id)
        } else {
            self.relay_clients
                .insert(snapshot.client_id.clone(), (snapshot, bytes))
        };
        if let Some((_, bytes)) = previous {
            self.release(bytes)?;
        }
        for session in &delta.removed {
            if let Some((id, bytes)) = self.relay_identities.remove(session) {
                self.release(bytes)?;
                self.release_subscription(&id, Direction::Send)?;
            }
        }
        Ok(delta)
    }
    pub fn release_relay_client(
        &mut self,
        client_id: &str,
        now_ms: u64,
    ) -> Result<RelayInterestDelta, ProtocolError> {
        self.update_relay_interests(
            v5::SubscriptionSnapshot {
                client_id: client_id.into(),
                session_ids: Vec::new(),
            },
            now_ms,
        )
    }
    pub fn register_relay_interest(
        &mut self,
        session_id: String,
        subscription_id: String,
        source_epoch: String,
        now_ms: u64,
    ) -> Result<(), ProtocolError> {
        self.time(now_ms)?;
        if self.phase != Phase::Established
            || self.config.local_role != v5::PeerRole::Agent
            || self.config.peer_role != v5::PeerRole::Relay
            || subscription_id.is_empty()
            || source_epoch.is_empty()
            || !self
                .relay_clients
                .values()
                .any(|(entry, _)| entry.session_ids.contains(&session_id))
            || self.relay_identities.contains_key(&session_id)
            || self.sending_subscriptions.contains_key(&subscription_id)
        {
            return Err(ProtocolError::Malformed);
        }
        if self.sending_subscriptions.len() >= limits::SUBSCRIPTIONS as usize {
            return Err(ProtocolError::Limit);
        }
        let bytes = (session_id.len() + subscription_id.len() + source_epoch.len()) as u64;
        if bytes > limits::SERVER_FRAME_BYTES || !self.reserve(bytes) {
            return Err(ProtocolError::Limit);
        }
        let Some(descriptor) = self
            .descriptors
            .iter()
            .find(|descriptor| descriptor.diagnostic_name == "event.subscribe")
        else {
            self.release(bytes)?;
            return Err(ProtocolError::Unknown);
        };
        self.sending_subscriptions.insert(
            subscription_id.clone(),
            Subscription {
                event_types: descriptor.event_types.clone(),
                scope: v5::Scope {
                    target: Some(v5::scope::Target::Session(session_id.clone())),
                },
                source_epoch: Some(source_epoch),
                hydration: None,
                bytes: 0,
                events: 0,
                invalidated: false,
                ending: false,
                resync_required: false,
            },
        );
        self.relay_identities
            .insert(session_id, (subscription_id, bytes));
        Ok(())
    }
    pub fn stats(&self) -> Stats {
        Stats {
            dropped_transfers: self.dropped_transfers,
            oversized_invalidations: self.oversized_invalidations,
            retained_bytes: self.owned_charge,
            admitted_bytes: self.admissions.values().map(|value| value.0).sum(),
            prepared_bytes: self.prepared.as_ref().map_or(0, |value| value.bytes),
            queued_bytes: self.queued_bytes,
            handed_bytes: std::array::from_fn(|index| self.send[index].outstanding_bytes()),
            received_bytes: std::array::from_fn(|index| {
                self.receive[index]
                    .bytes
                    .values()
                    .map(|record| record.charge)
                    .sum()
            }),
            hydration_bytes: self
                .subscriptions
                .values()
                .map(|subscription| subscription.bytes)
                .sum(),
            reassembly_reserved_bytes: if self.config.local_role == v5::PeerRole::Relay {
                0
            } else {
                self.transfers
                    .values()
                    .map(|transfer| transfer.start.byte_count)
                    .sum()
            },
            reassembly_received_bytes: self
                .transfers
                .values()
                .map(|transfer| transfer.bytes.len() as u64)
                .sum(),
            pending_requests: self.requests.len()
                + self.incoming.len()
                + self.awaiting_subscription.len(),
            subscriptions: self.subscriptions.len(),
        }
    }

    pub fn revoke(&mut self, code: u16) -> Result<Vec<Decision>, ProtocolError> {
        if code != 4401 && code != 4403 {
            return Err(ProtocolError::Malformed);
        }
        let mut decisions = self.close(ProtocolError::Direction);
        if let Some(Decision::Closed(close)) = decisions.last_mut() {
            close.code = code;
        }
        Ok(decisions)
    }

    pub fn replace_authority(
        &mut self,
        sessions: BTreeSet<String>,
        workspaces: BTreeSet<String>,
    ) -> Vec<Decision> {
        self.config.authorized_sessions = sessions;
        self.config.authorized_workspaces = workspaces;
        if self.config.local_role != v5::PeerRole::RemoteClient
            && self.config.peer_role != v5::PeerRole::RemoteClient
        {
            return Vec::new();
        }
        let invalid = self
            .requests
            .iter()
            .filter(|(_, pending)| !self.authorized(&pending.scope))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut decisions = Vec::new();
        for id in invalid {
            if let Some(pending) = self.requests.remove(&id) {
                if self.release(pending.asset_charge).is_err() {
                    return self.close(ProtocolError::Limit);
                }
                if self.remove_output(&id, None).is_err() {
                    return self.close(ProtocolError::Limit);
                }
                let transfers = self
                    .transfers
                    .iter()
                    .filter(|(_, transfer)| transfer.start.request_id == id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for transfer_id in transfers {
                    if let Some(transfer) = self.transfers.remove(&transfer_id)
                        && self.config.local_role != v5::PeerRole::Relay
                        && self
                            .release(transfer.start.byte_count + transfer.asset_charge)
                            .is_err()
                    {
                        return self.close(ProtocolError::Limit);
                    }
                }
                decisions.push(Decision::Settled {
                    request_id: id,
                    outcome: if pending.sent {
                        Outcome::Unknown
                    } else {
                        Outcome::Unsent
                    },
                });
            }
        }
        let invalid = self
            .incoming
            .iter()
            .filter(|(_, pending)| !self.authorized(&pending.scope))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in invalid {
            let cancel = v5::Cancel {
                target: Some(v5::cancel::Target::RequestId(id)),
            };
            match self.cancel_incoming(&cancel) {
                Ok(cancelled) => decisions.extend(cancelled),
                Err(error) => return self.close(error),
            }
        }
        let invalid = self
            .subscriptions
            .iter()
            .filter(|(_, subscription)| !self.authorized(&subscription.scope))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in invalid {
            if self.clear_hydration(&id).is_err() {
                return self.close(ProtocolError::Limit);
            }
            if let Some(subscription) = self.subscriptions.remove(&id) {
                decisions.push(Decision::Resync(v5::ResyncRequired {
                    scope: subscription.scope,
                    source_epoch: subscription.source_epoch.unwrap_or_default(),
                    message_id: None,
                }));
            }
        }
        self.awaiting_subscription
            .retain(|_, pending| match &pending.scope.target {
                Some(v5::scope::Target::Session(session)) => {
                    self.config.authorized_sessions.contains(session)
                }
                Some(v5::scope::Target::Workspace(workspace)) => {
                    self.config.authorized_workspaces.contains(workspace)
                }
                _ => false,
            });
        decisions
    }
    pub fn request(
        &mut self,
        operation_id: u32,
        scope: v5::Scope,
        payload: Vec<u8>,
        reserve_bytes: u64,
        now_ms: u64,
    ) -> Result<String, ProtocolError> {
        self.time(now_ms)?;
        let descriptor = self.descriptor(operation_id)?;
        self.request_contract(descriptor, &scope, &payload, self.config.local_role)?;
        if self.requests.len() + self.awaiting_subscription.len()
            >= limits::PENDING_REQUESTS as usize
        {
            return Err(ProtocolError::Limit);
        }
        let next = self
            .next_request
            .checked_add(1)
            .ok_or(ProtocolError::Limit)?;
        let request_id = self.next_request.to_string();
        self.queue_reserved(
            v5::frame::Body::Request(v5::Request {
                request_id: request_id.clone(),
                operation_id,
                scope: scope.clone(),
                payload,
            }),
            reserve_bytes,
            self.now,
        )?;
        self.requests.insert(
            request_id.clone(),
            Pending {
                operation_id,
                scope,
                sent: false,
                ..Default::default()
            },
        );
        self.next_request = next;
        Ok(request_id)
    }

    pub fn cancel_request(
        &mut self,
        request_id: &str,
        now_ms: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.time(now_ms)?;
        let Some(pending) = self.requests.get(request_id) else {
            return Ok(Vec::new());
        };
        let sent = pending.sent;
        if sent {
            self.enqueue_control(v5::control::Kind::Cancel(v5::Cancel {
                target: Some(v5::cancel::Target::RequestId(request_id.into())),
            }))?;
        }
        if let Some(pending) = self.requests.remove(request_id) {
            self.release(pending.asset_charge)?;
        }
        self.remove_output(request_id, None)?;
        let ids = self
            .transfers
            .iter()
            .filter(|(_, transfer)| transfer.start.request_id == request_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(transfer) = self.transfers.remove(&id)
                && self.config.local_role != v5::PeerRole::Relay
            {
                self.release(transfer.start.byte_count + transfer.asset_charge)?;
            }
        }
        Ok(vec![Decision::Settled {
            request_id: request_id.into(),
            outcome: if sent {
                Outcome::Unknown
            } else {
                Outcome::Unsent
            },
        }])
    }

    pub fn respond(
        &mut self,
        result: v5::Result,
        reserve_bytes: u64,
        now_ms: u64,
    ) -> Result<(), ProtocolError> {
        self.time(now_ms)?;
        let pending = self
            .incoming
            .get(&result.request_id)
            .ok_or(ProtocolError::Unknown)?;
        self.result_contract(&result, pending.operation_id)?;
        if matches!(result.outcome, Some(v5::result::Outcome::AssetMetadata(_)))
            && pending.asset_count.is_some()
        {
            return Err(ProtocolError::Malformed);
        }
        if self.queues[0].iter().any(|queued| matches!(&queued.frame.body, Some(v5::frame::Body::Result(existing)) if existing.request_id == result.request_id)) || self.outgoing_transfers.values().any(|transfer| transfer.start.request_id == result.request_id) { return Err(ProtocolError::Malformed); }
        let request_id = result.request_id.clone();
        let count = match &result.outcome {
            Some(v5::result::Outcome::AssetMetadata(metadata)) => Some(metadata.byte_count),
            _ => None,
        };
        self.queue_reserved(v5::frame::Body::Result(result), reserve_bytes, self.now)?;
        if let Some(count) = count {
            self.incoming
                .get_mut(&request_id)
                .ok_or(ProtocolError::Unknown)?
                .asset_count = Some(count);
        }
        Ok(())
    }

    pub fn enqueue(
        &mut self,
        body: v5::frame::Body,
        reserve_bytes: u64,
        now_ms: u64,
    ) -> Result<(), ProtocolError> {
        self.time(now_ms)?;
        let class = classify(&body);
        match &body {
            v5::frame::Body::StreamEnd(end) => {
                let error = if !boundary::allowed(&body, self.config.local_role)? {
                    Some(ProtocolError::Direction)
                } else if self
                    .sending_subscriptions
                    .get(&end.subscription_id)
                    .is_none_or(|subscription| subscription.ending)
                {
                    Some(ProtocolError::Malformed)
                } else {
                    None
                };
                if let Some(error) = error {
                    let decisions = self.close(error);
                    self.notifications.extend(decisions);
                    return Err(error);
                }
            }
            v5::frame::Body::BulkStart(start) => self.bulk_contract(start, false)?,
            v5::frame::Body::BulkPiece(piece) => self.piece_contract(piece, false)?,
            v5::frame::Body::BulkEnd(end) => self.end_contract(end, false)?,
            v5::frame::Body::Result(result) => {
                return self.respond(result.clone(), reserve_bytes, now_ms);
            }
            v5::frame::Body::EventBatch(_) => {
                let decisions = self.close(ProtocolError::Malformed);
                self.notifications.extend(decisions);
                return Err(ProtocolError::Malformed);
            }
            v5::frame::Body::Control(control)
                if control.kind.as_ref().is_some_and(|kind| {
                    !matches!(
                        kind,
                        v5::control::Kind::Ping(_)
                            | v5::control::Kind::Pong(_)
                            | v5::control::Kind::Credit(_)
                            | v5::control::Kind::Cancel(_)
                    )
                }) => {}
            _ => return Err(ProtocolError::Direction),
        }
        self.queue_reserved(body, reserve_bytes, self.now)?;
        if let Some(v5::frame::Body::StreamEnd(end)) = self.queues[class]
            .back()
            .and_then(|record| record.frame.body.as_ref())
        {
            let id = end.subscription_id.clone();
            self.sending_subscriptions
                .get_mut(&id)
                .ok_or(ProtocolError::Malformed)?
                .ending = true;
            self.queues[1].iter_mut().filter(|record| matches!(&record.frame.body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == id)).for_each(|record| record.ready_at = self.now);
        }
        match self.queues[class]
            .back()
            .and_then(|queued| queued.frame.body.as_ref())
        {
            Some(v5::frame::Body::BulkStart(start)) => {
                self.outgoing_transfers.insert(
                    start.transfer_id.clone(),
                    Transfer {
                        start: start.clone(),
                        index: 0,
                        received: 0,
                        bytes: Rc::new(Vec::new()),
                        complete: false,
                        started: false,
                        handed_pieces: 0,
                        asset_metadata: None,
                        asset_charge: 0,
                    },
                );
            }
            Some(v5::frame::Body::BulkPiece(piece)) => {
                let transfer = self
                    .outgoing_transfers
                    .get_mut(&piece.transfer_id)
                    .ok_or(ProtocolError::Unknown)?;
                transfer.index += 1;
                transfer.received += piece.data.len() as u64;
            }
            _ => (),
        }
        Ok(())
    }

    pub fn accept_subscription(
        &mut self,
        request_id: &str,
        subscription_id: String,
        scope: v5::Scope,
        now_ms: u64,
        direction: Direction,
        canonical_source_epoch: Option<String>,
    ) -> Result<(), ProtocolError> {
        let result = self.register_subscription(
            request_id,
            subscription_id,
            scope,
            now_ms,
            direction,
            canonical_source_epoch,
        );
        if let Err(error) = result {
            let category = if error == ProtocolError::Unknown {
                ProtocolError::Malformed
            } else {
                error
            };
            let decisions = self.close(category);
            self.notifications.extend(decisions);
            return Err(category);
        }
        result
    }

    fn register_subscription(
        &mut self,
        request_id: &str,
        subscription_id: String,
        scope: v5::Scope,
        now_ms: u64,
        direction: Direction,
        canonical_source_epoch: Option<String>,
    ) -> Result<(), ProtocolError> {
        self.time(now_ms)?;
        if self.phase != Phase::Established {
            return Err(ProtocolError::Closed);
        }
        let key = if direction == Direction::Receive {
            request_id.to_owned()
        } else {
            format!("sent:{request_id}")
        };
        let pending = self
            .awaiting_subscription
            .get(&key)
            .ok_or(ProtocolError::Unknown)?;
        let subscriptions = if direction == Direction::Receive {
            &self.subscriptions
        } else {
            &self.sending_subscriptions
        };
        if subscription_id.is_empty()
            || !matches!(
                scope.target,
                Some(v5::scope::Target::Session(_) | v5::scope::Target::Global(_))
            )
            || matches!(pending.scope.target, Some(v5::scope::Target::Session(_)))
                && scope != pending.scope
        {
            return Err(ProtocolError::Malformed);
        }
        if (self.config.local_role == v5::PeerRole::RemoteClient
            || self.config.peer_role == v5::PeerRole::RemoteClient)
            && !matches!(scope.target, Some(v5::scope::Target::Session(_)))
        {
            return Err(ProtocolError::Direction);
        }
        if self.config.local_role == v5::PeerRole::Relay
            && canonical_source_epoch.as_ref().is_none_or(String::is_empty)
        {
            return Err(ProtocolError::Direction);
        }
        let event_types = self.descriptor(pending.operation_id)?.event_types.clone();
        if let Some(existing) = subscriptions.get(&subscription_id) {
            if canonical_source_epoch.as_ref().is_none_or(String::is_empty)
                || !(self.config.local_role == v5::PeerRole::Relay
                    || self.config.local_role == v5::PeerRole::Agent
                        && direction == Direction::Send)
                || existing.scope != scope
                || existing.source_epoch != canonical_source_epoch
                || existing.event_types.len() != event_types.len()
                || !existing
                    .event_types
                    .iter()
                    .all(|kind| event_types.contains(kind))
            {
                return Err(ProtocolError::Malformed);
            }
            self.awaiting_subscription.remove(&key);
            return Ok(());
        }
        if subscriptions.len() >= limits::SUBSCRIPTIONS as usize {
            return Err(ProtocolError::Limit);
        }
        self.awaiting_subscription.remove(&key);
        let source_epoch =
            Some(canonical_source_epoch.unwrap_or_else(|| self.source_epoch.clone()));
        let subscriptions = if direction == Direction::Receive {
            &mut self.subscriptions
        } else {
            &mut self.sending_subscriptions
        };
        subscriptions.insert(
            subscription_id,
            Subscription {
                event_types,
                scope,
                source_epoch,
                hydration: None,
                bytes: 0,
                events: 0,
                invalidated: false,
                ending: false,
                resync_required: false,
            },
        );
        Ok(())
    }

    pub fn begin_hydration(&mut self, subscription_id: &str) -> Result<(), ProtocolError> {
        self.clear_hydration(subscription_id)?;
        let subscription = self
            .subscriptions
            .get_mut(subscription_id)
            .ok_or(ProtocolError::Unknown)?;
        subscription.hydration = Some(VecDeque::new());
        subscription.invalidated = false;
        Ok(())
    }

    pub fn complete_hydration(
        &mut self,
        subscription_id: &str,
        canonical_source_epoch: String,
        now_ms: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.time(now_ms)?;
        if canonical_source_epoch.is_empty() {
            return Err(ProtocolError::Epoch);
        }
        let subscription = self
            .subscriptions
            .get_mut(subscription_id)
            .ok_or(ProtocolError::Unknown)?;
        let batches = subscription
            .hydration
            .take()
            .ok_or(ProtocolError::Malformed)?;
        subscription.bytes = 0;
        subscription.events = 0;
        subscription.source_epoch = Some(canonical_source_epoch.clone());
        let scope = subscription.scope.clone();
        let released = batches.iter().map(|record| record.1).sum();
        let decisions = batches
            .into_iter()
            .map(|(batch, _)| {
                if batch.source_epoch == canonical_source_epoch {
                    return Decision::Events(batch);
                }
                Decision::Resync(v5::ResyncRequired {
                    scope: scope.clone(),
                    source_epoch: batch.source_epoch,
                    message_id: None,
                })
            })
            .collect::<Vec<_>>();
        let decisions = if subscription.invalidated {
            vec![Decision::Resync(v5::ResyncRequired {
                scope,
                source_epoch: canonical_source_epoch,
                message_id: None,
            })]
        } else {
            decisions
        };
        subscription.resync_required = decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Resync(_)));
        self.release(released)?;
        Ok(decisions)
    }

    pub fn release_subscription(
        &mut self,
        subscription_id: &str,
        direction: Direction,
    ) -> Result<bool, ProtocolError> {
        if direction == Direction::Receive {
            if !self.subscriptions.contains_key(subscription_id) {
                return Ok(false);
            }
            self.clear_hydration(subscription_id)?;
            return Ok(self.subscriptions.remove(subscription_id).is_some());
        }
        let existed = self.sending_subscriptions.remove(subscription_id).is_some();
        let identities = self
            .relay_identities
            .iter()
            .filter(|(_, (id, _))| id == subscription_id)
            .map(|(session, _)| session.clone())
            .collect::<Vec<_>>();
        for session in identities {
            if let Some((_, bytes)) = self.relay_identities.remove(&session) {
                self.release(bytes)?;
            }
        }
        let tickets = self.queues[1].iter().filter(|record| matches!(&record.frame.body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == subscription_id)).filter_map(|record| record.ticket).chain(self.prepared.as_ref().filter(|record| record.subscription_id.as_deref() == Some(subscription_id)).and_then(|record| record.ticket)).collect::<Vec<_>>();
        for ticket in tickets {
            if self.forwarded_tickets.remove(&ticket) {
                self.notifications.push(Decision::EventBatchReleased {
                    ticket,
                    consumed: false,
                });
            }
        }
        let mut released = self.queues[1]
            .iter()
            .filter(|record| match &record.frame.body {
                Some(v5::frame::Body::EventBatch(batch)) => {
                    batch.subscription_id == subscription_id
                }
                Some(v5::frame::Body::StreamEnd(end)) => end.subscription_id == subscription_id,
                _ => false,
            })
            .map(|record| record.bytes)
            .sum::<u64>();
        self.queues[1].retain(|record| match &record.frame.body {
            Some(v5::frame::Body::EventBatch(batch)) => batch.subscription_id != subscription_id,
            Some(v5::frame::Body::StreamEnd(end)) => end.subscription_id != subscription_id,
            _ => true,
        });
        if self
            .prepared
            .as_ref()
            .is_some_and(|record| record.subscription_id.as_deref() == Some(subscription_id))
        {
            released += self.prepared.take().ok_or(ProtocolError::Unknown)?.bytes;
        }
        self.queued_bytes[1] -= released;
        self.release(released)?;
        Ok(existed)
    }
    pub fn cancel_transfer(
        &mut self,
        transfer_id: &str,
        now_ms: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.time(now_ms)?;
        if let Some(transfer) = self.transfers.get(transfer_id) {
            if transfer.complete {
                self.release_bulk(transfer_id)?;
                return Ok(Vec::new());
            }
            let request_id = transfer.start.request_id.clone();
            let transfer = self
                .transfers
                .remove(transfer_id)
                .ok_or(ProtocolError::Unknown)?;
            if self.config.local_role != v5::PeerRole::Relay {
                self.release(transfer.start.byte_count + transfer.asset_charge)?;
            }
            self.requests.remove(&request_id);
            let mut decisions = if self.tiny_room() {
                match self.enqueue_control(v5::control::Kind::Cancel(v5::Cancel {
                    target: Some(v5::cancel::Target::TransferId(transfer_id.into())),
                })) {
                    Ok(()) => Vec::new(),
                    Err(error) => self.close(error),
                }
            } else {
                Vec::new()
            };
            decisions.push(Decision::Settled {
                request_id,
                outcome: Outcome::Unknown,
            });
            return Ok(decisions);
        }
        if self.outgoing_transfers.contains_key(transfer_id) {
            return self.cancel_incoming(&v5::Cancel {
                target: Some(v5::cancel::Target::TransferId(transfer_id.into())),
            });
        }
        Ok(Vec::new())
    }
    pub fn forward_event_batch(
        &mut self,
        batch: v5::EventBatch,
        now_ms: u64,
    ) -> Result<u64, ProtocolError> {
        self.time(now_ms)?;
        if self.phase != Phase::Established
            || self.config.local_role != v5::PeerRole::Relay
            || self.config.peer_role != v5::PeerRole::RemoteClient
        {
            return Err(ProtocolError::Direction);
        }
        let subscription = self
            .sending_subscriptions
            .get(&batch.subscription_id)
            .ok_or(ProtocolError::Malformed)?;
        if subscription.scope != batch.scope
            || subscription.source_epoch.as_deref() != Some(batch.source_epoch.as_str())
            || !self.authorized(&batch.scope)
        {
            return Err(ProtocolError::Direction);
        }
        self.valid_events(&batch, Direction::Send)?;
        let bytes = event_reservation_bytes(&batch, &self.epoch)?;
        self.queue_reserved(v5::frame::Body::EventBatch(batch), bytes, self.now)?;
        let ticket = self.queues[1]
            .back()
            .and_then(|record| record.ticket)
            .ok_or(ProtocolError::Unknown)?;
        self.forwarded_tickets.insert(ticket);
        Ok(ticket)
    }
    pub fn enqueue_event(
        &mut self,
        event: v5::EventRecord,
        metadata: EventMetadata,
        now_ms: u64,
    ) -> Result<(), ProtocolError> {
        self.time(now_ms)?;
        let subscription = self
            .sending_subscriptions
            .get(&metadata.subscription_id)
            .ok_or(ProtocolError::Direction)?;
        if subscription.ending
            || subscription.scope != metadata.scope
            || metadata.source_epoch.is_empty()
        {
            return Err(ProtocolError::Direction);
        }
        self.queues[1].iter_mut().filter(|record| matches!(&record.frame.body, Some(v5::frame::Body::EventBatch(previous)) if previous.scope == metadata.scope && previous.subscription_id != metadata.subscription_id)).for_each(|record| record.ready_at = self.now);
        let mut batch = v5::EventBatch {
            subscription_id: metadata.subscription_id.clone(),
            scope: metadata.scope.clone(),
            source_epoch: metadata.source_epoch.clone(),
            events: vec![event],
        };
        let reserve_bytes = event_reservation_bytes(&batch, &self.epoch)?;
        let cap = limits::EVENT_BATCH_BYTES.min(self.config.budgets.event_window_bytes);
        let ready_at = self.now.saturating_add(match metadata.priority {
            v5::PriorityMode::Interactive => self.config.budgets.interactive_coalesce_ms,
            v5::PriorityMode::Background => self.config.budgets.background_coalesce_ms,
        });
        if reserve_bytes <= cap {
            self.valid_events(&batch, Direction::Send)?;
            let open = self.queues[1].iter().position(|record| record.ready_at > self.now && matches!(&record.frame.body, Some(v5::frame::Body::EventBatch(previous)) if previous.subscription_id == batch.subscription_id && previous.scope == batch.scope && previous.events.len() < limits::EVENT_BATCH_COUNT as usize));
            if let Some(position) = open {
                let previous = match &self.queues[1][position].frame.body {
                    Some(v5::frame::Body::EventBatch(previous)) => previous,
                    _ => return Err(ProtocolError::Malformed),
                };
                let bytes =
                    events::merged_reservation_bytes(previous, &batch.events[0], &self.epoch)?;
                if previous.source_epoch == batch.source_epoch && bytes <= cap {
                    let extra = bytes - self.queues[1][position].bytes;
                    if self.queued_bytes[1] + extra > self.config.budgets.event_queue_bytes
                        || self.queued_event_count() + 1 > self.config.budgets.event_queue_count
                        || self.config.peer_role == v5::PeerRole::RemoteClient
                            && self.relay_delivery_bytes() + extra
                                > self.config.budgets.relay_peer_bytes
                    {
                        return Err(ProtocolError::Limit);
                    }
                    let ticket = self
                        .event_ticket
                        .checked_add(1)
                        .ok_or(ProtocolError::Limit)?;
                    if !self.reserve(extra) {
                        return Err(ProtocolError::Limit);
                    }
                    self.event_ticket = ticket;
                    let record = &mut self.queues[1][position];
                    if let Some(v5::frame::Body::EventBatch(previous)) = &mut record.frame.body {
                        previous.events.push(batch.events.remove(0));
                        record.ready_at = if previous.events.len()
                            == limits::EVENT_BATCH_COUNT as usize
                            || bytes == cap
                        {
                            self.now
                        } else {
                            record.ready_at.min(ready_at)
                        };
                    }
                    record.bytes = bytes;
                    record.ticket = Some(ticket);
                    self.queued_bytes[1] += extra;
                    return Ok(());
                }
                self.queues[1][position].ready_at = self.now;
            }
            self.sending_subscriptions
                .get_mut(&metadata.subscription_id)
                .ok_or(ProtocolError::Unknown)?
                .source_epoch = Some(metadata.source_epoch);
            self.queue_reserved(
                v5::frame::Body::EventBatch(batch),
                reserve_bytes,
                if reserve_bytes == cap {
                    self.now
                } else {
                    ready_at
                },
            )?;
            return Ok(());
        }
        let resync_reserve_bytes = events::resync_reservation_bytes(
            &metadata.scope,
            &metadata.source_epoch,
            metadata.message_id.as_deref(),
            &self.epoch,
        )?;
        let key = match &metadata.scope.target {
            Some(v5::scope::Target::Session(session)) => session.clone(),
            _ => metadata.subscription_id,
        };
        for record in &mut self.queues[1] {
            if record.event_key.as_deref() == Some(key.as_str()) {
                record.ready_at = self.now;
            }
        }
        let result = self.queue_reserved(
            v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::ResyncRequired(v5::ResyncRequired {
                    scope: metadata.scope,
                    source_epoch: metadata.source_epoch,
                    message_id: metadata.message_id,
                })),
            }),
            resync_reserve_bytes,
            self.now,
        );
        if let Err(error) = result {
            let decisions = self.close(error);
            self.notifications.extend(decisions);
            return Err(error);
        }
        let marker = self.queues[0].back_mut().ok_or(ProtocolError::Unknown)?;
        marker.event_fence = Some(self.event_ticket);
        marker.event_key = Some(key);
        self.oversized_invalidations = self.oversized_invalidations.saturating_add(1);
        Ok(())
    }
    pub fn new(
        config: Config,
        descriptors: Vec<v5::OperationDescriptor>,
        now_ms: u64,
    ) -> Result<Self, ProtocolError> {
        let mut ids = BTreeSet::new();
        for descriptor in &descriptors {
            if descriptor.operation_id == 0 || !ids.insert(descriptor.operation_id) {
                return Err(ProtocolError::Malformed);
            }
        }
        let (client, server) = if matches!(
            config.local_role,
            v5::PeerRole::LocalClient | v5::PeerRole::RemoteClient | v5::PeerRole::Agent
        ) {
            (config.local_role, config.peer_role)
        } else {
            (config.peer_role, config.local_role)
        };
        if !(client == v5::PeerRole::LocalClient && server == v5::PeerRole::Server
            || matches!(client, v5::PeerRole::RemoteClient | v5::PeerRole::Agent)
                && server == v5::PeerRole::Relay)
        {
            return Err(ProtocolError::Direction);
        }
        let windows = [
            config.budgets.normal_window_bytes,
            config.budgets.event_window_bytes,
            config.budgets.bulk_window_bytes,
            config.budgets.tiny_queue_bytes,
        ];
        let reservation = match &config.reservation {
            Some(reservation) => reservation.clone(),
            None => {
                let total = [
                    config.budgets.normal_window_bytes,
                    config.budgets.normal_queue_bytes,
                    config.budgets.event_window_bytes,
                    config.budgets.event_queue_bytes,
                    config.budgets.bulk_window_bytes,
                    config.budgets.bulk_window_bytes,
                    config.budgets.tiny_queue_bytes,
                    config.budgets.tiny_queue_bytes,
                    limits::HANDSHAKE_RETAINED_BYTES,
                    limits::BULK_MESSAGE_BYTES,
                ]
                .into_iter()
                .try_fold(0u64, u64::checked_add)
                .ok_or(ProtocolError::Limit)?;
                Rc::new(RefCell::new(ReservationBudget::new(total)?))
            }
        };
        Ok(Self {
            deadline: now_ms.saturating_add(limits::HANDSHAKE_TIMEOUT_MS),
            config,
            reservation,
            descriptors,
            owner: Rc::new(()),
            owned_charge: 0,
            authority_version: 0,
            next_token: 1,
            admissions: BTreeMap::new(),
            prepared: None,
            notifications: Vec::new(),
            hello_handed: false,
            ready_handed: false,
            now: now_ms,
            phase: Phase::Initial,
            epoch: String::new(),
            source_epoch: String::new(),
            send: windows.map(Ledger::new),
            receive: std::array::from_fn(|_| ReceiveLedger::default()),
            queues: std::array::from_fn(|_| VecDeque::new()),
            queued_bytes: [0; 4],
            requests: BTreeMap::new(),
            incoming: BTreeMap::new(),
            next_request: 1,
            subscriptions: BTreeMap::new(),
            awaiting_subscription: BTreeMap::new(),
            sending_subscriptions: BTreeMap::new(),
            relay_clients: BTreeMap::new(),
            relay_identities: BTreeMap::new(),
            forwarded_tickets: BTreeSet::new(),
            resync_fences: BTreeMap::new(),
            event_ticket: 0,
            handed_events: BTreeMap::new(),
            oversized_invalidations: 0,
            dropped_transfers: 0,
            transfers: BTreeMap::new(),
            outgoing_transfers: BTreeMap::new(),
            ping: None,
            next_ping: 1,
            last_ping: None,
            peer_ping: None,
            tiny_rates: std::array::from_fn(|_| VecDeque::new()),
            normal_rates: std::array::from_fn(|_| VecDeque::new()),
            event_rotation: None,
            bulk_rotation: None,
            event_weight: 0,
        })
    }

    pub fn start(&mut self, now_ms: u64) -> Result<Vec<Decision>, ProtocolError> {
        self.time(now_ms)?;
        if self.phase != Phase::Initial || !self.initiator() {
            return Err(ProtocolError::Direction);
        }
        let frame = handshake(
            v5::frame::Body::Hello(v5::Hello {
                revision: 5,
                contract_digest: digest(),
                role: self.config.local_role as i32,
                receive_windows: self.windows(),
            }),
            None,
        );
        self.queue_handshake(frame)?;
        self.phase = Phase::Hello;
        self.deadline = self.now.saturating_add(limits::HANDSHAKE_TIMEOUT_MS);
        Ok(Vec::new())
    }

    fn receive_reserved(
        &mut self,
        frame: v5::Frame,
        encoded_bytes: u64,
        now_ms: u64,
    ) -> Vec<Decision> {
        if self.phase == Phase::Closed {
            return Vec::new();
        }
        match self.receive_inner(frame, encoded_bytes, now_ms) {
            Ok(decisions) => decisions,
            Err(error) => self.close(error),
        }
    }

    fn receive_inner(
        &mut self,
        frame: v5::Frame,
        encoded_bytes: u64,
        now_ms: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.time(now_ms)?;
        self.check_size(&frame, encoded_bytes, self.config.peer_role)?;
        self.envelope(&frame, self.config.peer_role)?;
        if self.phase != Phase::Established && self.phase != Phase::Confirm {
            match frame.body {
                Some(v5::frame::Body::Hello(hello))
                    if !self.initiator() && self.phase == Phase::Initial =>
                {
                    if frame.connection_epoch.is_some() {
                        return Err(ProtocolError::Epoch);
                    }
                    self.negotiate(&hello.receive_windows)?;
                    let ready = handshake(
                        v5::frame::Body::Ready(v5::Ready {
                            revision: 5,
                            contract_digest: digest(),
                            role: self.config.local_role as i32,
                            receive_windows: self.windows(),
                            source_epoch: self.config.source_epoch.clone(),
                            connection_epoch: self.config.connection_epoch.clone(),
                        }),
                        Some(self.config.connection_epoch.clone()),
                    );
                    self.queue_handshake(ready)?;
                    self.epoch = self.config.connection_epoch.clone();
                    self.source_epoch = self.config.source_epoch.clone();
                    self.phase = Phase::Confirm;
                    self.last_ping = Some(self.now);
                    self.deadline = self.now.saturating_add(limits::HANDSHAKE_TIMEOUT_MS);
                    return Ok(Vec::new());
                }
                Some(v5::frame::Body::Ready(ready))
                    if self.initiator() && self.phase == Phase::Hello =>
                {
                    if !self.hello_handed
                        || ready.source_epoch.is_empty()
                        || ready.connection_epoch.is_empty()
                        || frame.connection_epoch.as_deref()
                            != Some(ready.connection_epoch.as_str())
                    {
                        return Err(ProtocolError::Epoch);
                    }
                    if ready.receive_windows.normal_bytes > self.config.budgets.normal_window_bytes
                        || ready.receive_windows.event_bytes
                            > self.config.budgets.event_window_bytes
                        || ready.receive_windows.bulk_bytes > self.config.budgets.bulk_window_bytes
                    {
                        return Err(ProtocolError::Limit);
                    }
                    self.epoch = ready.connection_epoch;
                    self.source_epoch = ready.source_epoch;
                    self.send[0] = Ledger::new(ready.receive_windows.normal_bytes);
                    self.send[1] = Ledger::new(ready.receive_windows.event_bytes);
                    self.send[2] = Ledger::new(ready.receive_windows.bulk_bytes);
                    self.config.budgets.normal_window_bytes = ready.receive_windows.normal_bytes;
                    self.config.budgets.event_window_bytes = ready.receive_windows.event_bytes;
                    self.config.budgets.bulk_window_bytes = ready.receive_windows.bulk_bytes;
                    self.phase = Phase::Established;
                    self.deadline = self.now.saturating_add(limits::HANDSHAKE_TIMEOUT_MS);
                    self.queue_ping()?;
                    return Ok(vec![Decision::Established]);
                }
                _ => return Err(ProtocolError::Incompatible),
            }
        }
        if matches!(
            frame.body,
            Some(v5::frame::Body::Hello(_) | v5::frame::Body::Ready(_))
        ) {
            return Err(ProtocolError::Incompatible);
        }
        if self.phase == Phase::Confirm
            && (!self.ready_handed
                || !matches!(
                    frame.body,
                    Some(
                        v5::frame::Body::Request(_)
                            | v5::frame::Body::Control(v5::Control {
                                kind: Some(v5::control::Kind::Ping(_))
                            })
                    )
                ))
        {
            return Err(ProtocolError::Epoch);
        }
        let class = classify(frame.body.as_ref().ok_or(ProtocolError::Malformed)?);
        self.admit_received(
            class,
            frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
            encoded_bytes,
        )?;
        if let Some(receipt) = frame.tiny_consumed_through {
            let released = self.send[3]
                .receipt(receipt)
                .map_err(|_| ProtocolError::Malformed)?;
            self.release(released)?;
        }
        let confirmed = self.phase == Phase::Confirm;
        self.phase = Phase::Established;
        let bounded_transfer = self.config.local_role != v5::PeerRole::Relay
            && matches!(
                frame.body,
                Some(
                    v5::frame::Body::BulkStart(_)
                        | v5::frame::Body::BulkPiece(_)
                        | v5::frame::Body::BulkEnd(_)
                )
            );
        let ordinal = frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?;
        let mut decisions = self.apply(frame, encoded_bytes)?;
        if (bounded_transfer
            || class == 1
                && !decisions
                    .iter()
                    .any(|decision| matches!(decision, Decision::Events(_) | Decision::Forward(_))))
            && self.receive[class]
                .bytes
                .get(&ordinal)
                .is_some_and(|record| !record.consumed)
        {
            self.consume(
                v5::LedgerClass::try_from((class + 1) as i32)
                    .map_err(|_| ProtocolError::Malformed)?,
                ordinal,
                self.now,
            )?;
        }
        if class == 3 {
            self.consume(v5::LedgerClass::Tiny, self.receive[3].last, self.now)?;
        }
        if confirmed {
            decisions.insert(0, Decision::Established);
        }
        Ok(decisions)
    }

    pub fn advance(&mut self, now_ms: u64) -> Vec<Decision> {
        if self.phase == Phase::Closed {
            return Vec::new();
        }
        match self.time(now_ms).and_then(|()| self.advance_inner()) {
            Ok(()) => Vec::new(),
            Err(error) => self.close(error),
        }
    }

    fn advance_inner(&mut self) -> Result<(), ProtocolError> {
        if !matches!(self.phase, Phase::Established | Phase::Confirm) {
            return Ok(());
        }
        for index in 0..3 {
            let receive = &self.receive[index];
            if receive.pending_bytes > 0
                && (receive.pending_bytes >= self.config.budgets.credit_bytes
                    || receive.pending_since.is_some_and(|since| {
                        self.now.saturating_sub(since) >= self.config.budgets.credit_delay_ms
                    }))
            {
                let consumed = receive.consumed;
                if self.tiny_room() {
                    self.enqueue_control(v5::control::Kind::Credit(v5::Credit {
                        ledger: (index + 1) as i32,
                        consumed_through: consumed,
                    }))?;
                    self.receive[index].pending_bytes = 0;
                    self.receive[index].pending_since = None;
                }
            }
        }
        if self.phase == Phase::Established
            && self.ping.is_none()
            && self.last_ping.is_some_and(|last| {
                self.now.saturating_sub(last) >= self.config.budgets.ping_interval_ms
            })
            && self.tiny_room()
        {
            self.queue_ping()?;
        }
        Ok(())
    }

    fn mark_handed(&mut self, frame: &v5::Frame) -> Result<(), ProtocolError> {
        if let Some(v5::frame::Body::StreamEnd(end)) = &frame.body
            && let Some(subscription) = self.sending_subscriptions.remove(&end.subscription_id)
        {
            self.event_rotation = Some(match subscription.scope.target {
                Some(v5::scope::Target::Session(session)) => session,
                _ => end.subscription_id.clone(),
            });
            self.event_weight = self.event_weight.saturating_add(1).min(2);
        }
        if let Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::ResyncRequired(resync)),
        })) = &frame.body
        {
            self.resync_fences.insert(
                frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
                resync.scope.clone(),
            );
        }
        if let Some(v5::frame::Body::EventBatch(batch)) = &frame.body {
            self.event_weight = self.event_weight.saturating_add(1).min(2);
            self.event_rotation = Some(match &batch.scope.target {
                Some(v5::scope::Target::Session(session)) => session.clone(),
                _ => batch.subscription_id.clone(),
            });
        }
        if let Some(v5::frame::Body::BulkPiece(piece)) = &frame.body {
            self.event_weight = 0;
            self.bulk_rotation = Some(piece.transfer_id.clone());
        }
        if let Some(v5::frame::Body::Hello(_)) = &frame.body {
            self.hello_handed = true;
            self.deadline = self.now.saturating_add(limits::HANDSHAKE_TIMEOUT_MS);
        }
        if let Some(v5::frame::Body::Ready(_)) = &frame.body {
            self.ready_handed = true;
            self.deadline = self.now.saturating_add(limits::HANDSHAKE_TIMEOUT_MS);
        }
        let consumed_tiny = self.receive[3].consumed;
        self.receive[3]
            .bytes
            .retain(|ordinal, _| *ordinal > consumed_tiny);
        if let Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Credit(credit)),
        })) = &frame.body
        {
            self.receive[class_index(credit.ledger)?]
                .bytes
                .retain(|ordinal, _| *ordinal > credit.consumed_through);
        }
        if let Some(v5::frame::Body::Request(request)) = &frame.body
            && let Some(pending) = self.requests.get_mut(&request.request_id)
        {
            pending.sent = true;
        }
        if let Some(v5::frame::Body::Result(result)) = &frame.body
            && !matches!(result.outcome, Some(v5::result::Outcome::AssetMetadata(_)))
            && let Some(pending) = self.incoming.remove(&result.request_id)
            && self.descriptor(pending.operation_id)?.streaming == v5::Streaming::Events as i32
            && matches!(result.outcome, Some(v5::result::Outcome::Success(_)))
        {
            self.awaiting_subscription
                .insert(format!("sent:{}", result.request_id), pending);
        }
        if let Some(v5::frame::Body::BulkEnd(end)) = &frame.body
            && let Some(transfer) = self.outgoing_transfers.remove(&end.transfer_id)
        {
            self.incoming.remove(&transfer.start.request_id);
        }
        if let Some(v5::frame::Body::BulkStart(start)) = &frame.body
            && let Some(transfer) = self.outgoing_transfers.get_mut(&start.transfer_id)
        {
            transfer.started = true;
        }
        if let Some(v5::frame::Body::BulkPiece(piece)) = &frame.body
            && let Some(transfer) = self.outgoing_transfers.get_mut(&piece.transfer_id)
        {
            transfer.handed_pieces += 1;
        }
        if let Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Ping(ping)),
        })) = &frame.body
        {
            self.ping = Some(ping.id);
            self.last_ping = Some(self.now);
        }
        Ok(())
    }

    fn apply(
        &mut self,
        mut frame: v5::Frame,
        encoded_bytes: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        let forwarded = self.config.local_role == v5::PeerRole::Relay;
        match frame.body.take().ok_or(ProtocolError::Malformed)? {
            v5::frame::Body::StreamEnd(end) => {
                let subscription = self
                    .subscriptions
                    .get(&end.subscription_id)
                    .ok_or(ProtocolError::Malformed)?;
                if subscription.hydration.is_some()
                    || subscription.invalidated
                    || subscription.resync_required
                {
                    return Err(ProtocolError::Malformed);
                }
                if !forwarded {
                    self.consume(
                        v5::LedgerClass::Event,
                        frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
                        self.now,
                    )?;
                }
                self.release_subscription(&end.subscription_id, Direction::Receive)?;
                Ok(vec![Decision::StreamComplete(end.subscription_id)])
            }
            v5::frame::Body::Request(request) => {
                let descriptor = self.descriptor(request.operation_id)?;
                self.request_contract(
                    descriptor,
                    &request.scope,
                    &request.payload,
                    self.config.peer_role,
                )?;
                if self.incoming.contains_key(&request.request_id) {
                    return Err(ProtocolError::Malformed);
                }
                if self.incoming.len() >= limits::PENDING_REQUESTS as usize {
                    return Err(ProtocolError::Limit);
                }
                self.incoming.insert(
                    request.request_id.clone(),
                    Pending {
                        operation_id: request.operation_id,
                        scope: request.scope.clone(),
                        sent: true,
                        ..Default::default()
                    },
                );
                if forwarded {
                    frame.body = Some(v5::frame::Body::Request(request));
                    return Ok(vec![Decision::Forward(frame)]);
                }
                Ok(vec![Decision::Request(request)])
            }
            v5::frame::Body::Result(result) => {
                let Some(pending) = self.requests.get(&result.request_id) else {
                    self.late_id(&result.request_id)?;
                    return Ok(Vec::new());
                };
                if !pending.sent
                    || self
                        .transfers
                        .values()
                        .any(|transfer| transfer.start.request_id == result.request_id)
                {
                    return Err(ProtocolError::Malformed);
                }
                self.result_contract(&result, pending.operation_id)?;
                let descriptor = self.descriptor(pending.operation_id)?;
                let settlement = v5::Settlement::try_from(descriptor.settlement)
                    .map_err(|_| ProtocolError::Malformed)?;
                if let Some(v5::result::Outcome::AssetMetadata(metadata)) = &result.outcome {
                    if pending.asset_count.is_some() {
                        return Err(ProtocolError::Malformed);
                    }
                    let count = metadata.byte_count;
                    if forwarded {
                        self.requests
                            .get_mut(&result.request_id)
                            .ok_or(ProtocolError::Unknown)?
                            .asset_count = Some(count);
                        frame.body = Some(v5::frame::Body::Result(result));
                        return Ok(vec![Decision::Forward(frame)]);
                    }
                    if !self.reserve(encoded_bytes) {
                        return Err(ProtocolError::Limit);
                    }
                    let Some(v5::result::Outcome::AssetMetadata(metadata)) = result.outcome else {
                        return Err(ProtocolError::Malformed);
                    };
                    let metadata = Rc::new(metadata);
                    let pending = self
                        .requests
                        .get_mut(&result.request_id)
                        .ok_or(ProtocolError::Unknown)?;
                    pending.asset_count = Some(count);
                    pending.asset_charge = encoded_bytes;
                    pending.asset_metadata = Some(metadata.clone());
                    self.consume(
                        v5::LedgerClass::Normal,
                        frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
                        self.now,
                    )?;
                    return Ok(vec![Decision::AssetMetadata {
                        request_id: result.request_id,
                        metadata,
                    }]);
                }
                if descriptor.streaming == v5::Streaming::Events as i32
                    && matches!(&result.outcome, Some(v5::result::Outcome::Success(_)))
                {
                    self.awaiting_subscription
                        .insert(result.request_id.clone(), pending.clone());
                }
                if let Some(pending) = self.requests.remove(&result.request_id) {
                    self.release(pending.asset_charge)?;
                }
                if forwarded {
                    frame.body = Some(v5::frame::Body::Result(result));
                    return Ok(vec![Decision::Forward(frame)]);
                }
                let outcome = match result.outcome.ok_or(ProtocolError::Malformed)? {
                    v5::result::Outcome::Success(payload) => Outcome::Success {
                        settlement,
                        payload,
                    },
                    v5::result::Outcome::Error(payload) => Outcome::Rejected(payload),
                    v5::result::Outcome::AssetMetadata(_) => return Err(ProtocolError::Malformed),
                };
                Ok(vec![Decision::Settled {
                    request_id: result.request_id,
                    outcome,
                }])
            }
            v5::frame::Body::EventBatch(batch) => {
                self.valid_events(&batch, Direction::Receive)?;
                let subscription = self
                    .subscriptions
                    .get(&batch.subscription_id)
                    .ok_or(ProtocolError::Malformed)?;
                if subscription.scope != batch.scope {
                    return Err(ProtocolError::Direction);
                }
                if subscription.hydration.is_none()
                    && (subscription.source_epoch.as_deref() != Some(batch.source_epoch.as_str())
                        || subscription.invalidated)
                {
                    let scope = subscription.scope.clone();
                    self.clear_hydration(&batch.subscription_id)?;
                    let subscription = self
                        .subscriptions
                        .get_mut(&batch.subscription_id)
                        .ok_or(ProtocolError::Unknown)?;
                    subscription.resync_required = true;
                    subscription.hydration = None;
                    subscription.bytes = 0;
                    subscription.events = 0;
                    return Ok(vec![Decision::Resync(v5::ResyncRequired {
                        scope,
                        source_epoch: batch.source_epoch,
                        message_id: None,
                    })]);
                }
                if subscription.hydration.is_none() {
                    if forwarded {
                        frame.body = Some(v5::frame::Body::EventBatch(batch));
                        return Ok(vec![Decision::Forward(frame)]);
                    }
                    return Ok(vec![Decision::Events(batch)]);
                }
                let bytes = self
                    .subscriptions
                    .values()
                    .map(|subscription| subscription.bytes)
                    .sum::<u64>();
                let events = self
                    .subscriptions
                    .values()
                    .map(|subscription| subscription.events)
                    .sum::<usize>();
                if bytes + encoded_bytes > self.config.budgets.event_queue_bytes
                    || events + batch.events.len() > self.config.budgets.event_queue_count
                    || !self.reserve(encoded_bytes)
                {
                    self.clear_hydration(&batch.subscription_id)?;
                    let subscription = self
                        .subscriptions
                        .get_mut(&batch.subscription_id)
                        .ok_or(ProtocolError::Unknown)?;
                    subscription.hydration = None;
                    subscription.bytes = 0;
                    subscription.events = 0;
                    subscription.invalidated = true;
                    subscription.resync_required = true;
                    return Ok(vec![Decision::Resync(v5::ResyncRequired {
                        scope: batch.scope,
                        source_epoch: batch.source_epoch,
                        message_id: None,
                    })]);
                }
                let subscription = self
                    .subscriptions
                    .get_mut(&batch.subscription_id)
                    .ok_or(ProtocolError::Unknown)?;
                subscription.bytes += encoded_bytes;
                subscription.events += batch.events.len();
                if let Some(hydration) = &mut subscription.hydration {
                    hydration.push_back((batch, encoded_bytes));
                }
                Ok(Vec::new())
            }
            v5::frame::Body::BulkStart(start) => {
                self.bulk_contract(&start, true)?;
                let mut bytes = Vec::new();
                if !forwarded {
                    if !self.reserve(start.byte_count) {
                        return Err(ProtocolError::Limit);
                    }
                    bytes
                        .try_reserve_exact(start.byte_count as usize)
                        .map_err(|_| ProtocolError::Limit)?;
                }
                self.transfers.insert(
                    start.transfer_id.clone(),
                    Transfer {
                        start: start.clone(),
                        index: 0,
                        received: 0,
                        bytes: Rc::new(bytes),
                        complete: false,
                        started: true,
                        handed_pieces: 0,
                        asset_metadata: self
                            .requests
                            .get(&start.request_id)
                            .and_then(|pending| pending.asset_metadata.clone()),
                        asset_charge: self
                            .requests
                            .get(&start.request_id)
                            .map_or(0, |pending| pending.asset_charge),
                    },
                );
                self.requests
                    .get_mut(&start.request_id)
                    .ok_or(ProtocolError::Unknown)?
                    .asset_charge = 0;
                if forwarded {
                    frame.body = Some(v5::frame::Body::BulkStart(start));
                    return Ok(vec![Decision::Forward(frame)]);
                }
                Ok(Vec::new())
            }
            v5::frame::Body::BulkPiece(piece) => {
                if !self.transfers.contains_key(&piece.transfer_id) {
                    self.consume(
                        v5::LedgerClass::Bulk,
                        frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
                        self.now,
                    )?;
                    self.dropped_transfers = self.dropped_transfers.saturating_add(1);
                    return Ok(Vec::new());
                }
                self.piece_contract(&piece, true)?;
                let transfer = self
                    .transfers
                    .get_mut(&piece.transfer_id)
                    .ok_or(ProtocolError::Unknown)?;
                transfer.index += 1;
                transfer.received += piece.data.len() as u64;
                if !forwarded {
                    Rc::get_mut(&mut transfer.bytes)
                        .ok_or(ProtocolError::Malformed)?
                        .extend_from_slice(&piece.data);
                }
                if forwarded {
                    frame.body = Some(v5::frame::Body::BulkPiece(piece));
                    return Ok(vec![Decision::Forward(frame)]);
                }
                Ok(Vec::new())
            }
            v5::frame::Body::BulkEnd(end) => {
                if !self.transfers.contains_key(&end.transfer_id) {
                    self.consume(
                        v5::LedgerClass::Normal,
                        frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
                        self.now,
                    )?;
                    self.dropped_transfers = self.dropped_transfers.saturating_add(1);
                    return Ok(Vec::new());
                }
                self.end_contract(&end, true)?;
                let transfer = self
                    .transfers
                    .get(&end.transfer_id)
                    .ok_or(ProtocolError::Unknown)?;
                let descriptor = self.descriptor(transfer.start.operation_id)?;
                let settlement = v5::Settlement::try_from(descriptor.settlement)
                    .map_err(|_| ProtocolError::Malformed)?;
                if forwarded {
                    let request_id = transfer.start.request_id.clone();
                    self.requests.remove(&request_id);
                    self.transfers.remove(&end.transfer_id);
                    frame.body = Some(v5::frame::Body::BulkEnd(end));
                    return Ok(vec![Decision::Forward(frame)]);
                }
                let request_id = transfer.start.request_id.clone();
                let outcome = match end.outcome.ok_or(ProtocolError::Malformed)? {
                    v5::bulk_end::Outcome::Error(error) => Outcome::Rejected(error),
                    v5::bulk_end::Outcome::Success(_) => {
                        if !forwarded
                            && transfer.start.content_kind == v5::ContentKind::TypedMessage as i32
                        {
                            crate::validate_binary(&transfer.start.type_name, &transfer.bytes)
                                .map_err(wire_error)?;
                        }
                        if transfer.start.content_kind == v5::ContentKind::Asset as i32 {
                            Outcome::AssetSuccess {
                                settlement,
                                metadata: transfer
                                    .asset_metadata
                                    .clone()
                                    .ok_or(ProtocolError::Malformed)?,
                                start: transfer.start.clone(),
                                bytes: transfer.bytes.clone(),
                            }
                        } else {
                            Outcome::BulkSuccess {
                                settlement,
                                start: transfer.start.clone(),
                                bytes: transfer.bytes.clone(),
                            }
                        }
                    }
                };
                if matches!(outcome, Outcome::Rejected(_)) {
                    let transfer = self
                        .transfers
                        .remove(&end.transfer_id)
                        .ok_or(ProtocolError::Unknown)?;
                    self.release(transfer.start.byte_count + transfer.asset_charge)?;
                } else {
                    self.transfers
                        .get_mut(&end.transfer_id)
                        .ok_or(ProtocolError::Unknown)?
                        .complete = true;
                }
                self.requests.remove(&request_id);
                Ok(vec![Decision::Settled {
                    request_id,
                    outcome,
                }])
            }
            v5::frame::Body::Control(control) => {
                match control.kind.as_ref().ok_or(ProtocolError::Malformed)? {
                    v5::control::Kind::Credit(credit) => {
                        let class = class_index(credit.ledger)?;
                        if class == 3 {
                            return Err(ProtocolError::Malformed);
                        }
                        let released = self.send[class]
                            .credit(credit.consumed_through)
                            .map_err(|_| ProtocolError::Malformed)?;
                        self.release(released)?;
                        if class == 0 {
                            self.resync_fences
                                .retain(|ordinal, _| *ordinal > credit.consumed_through);
                        }
                        if class == 1 {
                            let tickets = self
                                .handed_events
                                .range(..=credit.consumed_through)
                                .map(|(_, (ticket, _))| *ticket)
                                .filter(|ticket| self.forwarded_tickets.contains(ticket))
                                .collect::<Vec<_>>();
                            for ticket in tickets {
                                self.forwarded_tickets.remove(&ticket);
                                self.notifications.push(Decision::EventBatchReleased {
                                    ticket,
                                    consumed: true,
                                });
                            }
                            self.handed_events
                                .retain(|ordinal, _| *ordinal > credit.consumed_through);
                        }
                        Ok(Vec::new())
                    }
                    v5::control::Kind::Ping(ping) => {
                        if self.peer_ping == Some(ping.id) {
                            return Ok(Vec::new());
                        }
                        self.peer_ping = Some(ping.id);
                        if !self.tiny_room() {
                            return Ok(Vec::new());
                        }
                        self.enqueue_control(v5::control::Kind::Pong(v5::Pong { id: ping.id }))?;
                        Ok(Vec::new())
                    }
                    v5::control::Kind::Pong(pong) => {
                        if self.ping == Some(pong.id) {
                            self.ping = None;
                        }
                        Ok(Vec::new())
                    }
                    v5::control::Kind::Cancel(cancel) => self.cancel_incoming(cancel),
                    v5::control::Kind::Failure(failure) => Err(
                        match v5::FailureCategory::try_from(failure.category)
                            .map_err(|_| ProtocolError::Malformed)?
                        {
                            v5::FailureCategory::Malformed => ProtocolError::Malformed,
                            v5::FailureCategory::Incompatible => ProtocolError::Incompatible,
                            v5::FailureCategory::Limit => ProtocolError::Limit,
                            v5::FailureCategory::Direction => ProtocolError::Direction,
                            v5::FailureCategory::Epoch => ProtocolError::Epoch,
                        },
                    ),
                    v5::control::Kind::ResyncRequired(resync) => {
                        let ids = self
                            .subscriptions
                            .iter()
                            .filter(|(_, subscription)| subscription.scope == resync.scope)
                            .map(|(id, _)| id.clone())
                            .collect::<Vec<_>>();
                        for id in ids {
                            self.clear_hydration(&id)?;
                            let subscription = self
                                .subscriptions
                                .get_mut(&id)
                                .ok_or(ProtocolError::Unknown)?;
                            subscription.invalidated = true;
                            subscription.resync_required = true;
                            subscription.bytes = 0;
                            subscription.events = 0;
                        }
                        self.consume(
                            v5::LedgerClass::Normal,
                            frame.delivery_ordinal.ok_or(ProtocolError::Malformed)?,
                            self.now,
                        )?;
                        Ok(vec![Decision::Resync(resync.clone())])
                    }
                    _ => Ok(vec![Decision::Control(control)]),
                }
            }
            _ => Err(ProtocolError::Incompatible),
        }
    }

    pub fn consume(
        &mut self,
        class: v5::LedgerClass,
        ordinal: u64,
        now_ms: u64,
    ) -> Result<u64, ProtocolError> {
        self.time(now_ms)?;
        let receive = &mut self.receive[class as usize - 1];
        let record = receive
            .bytes
            .get_mut(&ordinal)
            .ok_or(ProtocolError::Malformed)?;
        if record.consumed {
            return Err(ProtocolError::Malformed);
        }
        record.consumed = true;
        let released = std::mem::take(&mut record.charge);
        let previous = receive.consumed;
        while let Some(next) = receive.consumed.checked_add(1) {
            if !receive
                .bytes
                .get(&next)
                .is_some_and(|record| record.consumed)
            {
                break;
            }
            receive.consumed = next;
        }
        let freed = receive
            .bytes
            .range((
                std::ops::Bound::Excluded(previous),
                std::ops::Bound::Included(receive.consumed),
            ))
            .map(|(_, record)| record.bytes)
            .sum::<u64>();
        if class != v5::LedgerClass::Tiny && freed > 0 {
            receive.pending_bytes = receive
                .pending_bytes
                .checked_add(freed)
                .ok_or(ProtocolError::Limit)?;
            receive.pending_since.get_or_insert(self.now);
        }
        self.release(released)?;
        Ok(freed)
    }

    pub fn release_bulk(&mut self, transfer_id: &str) -> Result<(), ProtocolError> {
        let transfer = self
            .transfers
            .get(transfer_id)
            .ok_or(ProtocolError::Unknown)?;
        if !transfer.complete {
            return Err(ProtocolError::Malformed);
        }
        let transfer = self
            .transfers
            .remove(transfer_id)
            .ok_or(ProtocolError::Unknown)?;
        self.release(transfer.start.byte_count + transfer.asset_charge)
    }

    fn clear_hydration(&mut self, subscription_id: &str) -> Result<(), ProtocolError> {
        let subscription = self
            .subscriptions
            .get_mut(subscription_id)
            .ok_or(ProtocolError::Unknown)?;
        let bytes = std::mem::take(&mut subscription.bytes);
        subscription.events = 0;
        if let Some(hydration) = &mut subscription.hydration {
            hydration.clear();
        }
        self.release(bytes)
    }

    fn valid_events(
        &self,
        batch: &v5::EventBatch,
        direction: Direction,
    ) -> Result<(), ProtocolError> {
        let subscription = if direction == Direction::Receive {
            &self.subscriptions
        } else {
            &self.sending_subscriptions
        }
        .get(&batch.subscription_id);
        for event in &batch.events {
            if event.event_id.is_empty()
                || !self.config.event_types.contains(&event.event.type_name)
                || subscription.is_some_and(|subscription| {
                    !subscription.event_types.contains(&event.event.type_name)
                })
            {
                return Err(ProtocolError::Malformed);
            }
            if self.config.local_role != v5::PeerRole::Relay {
                crate::validate_binary(&event.event.type_name, &event.event.payload)
                    .map_err(wire_error)?;
            }
        }
        Ok(())
    }

    fn time(&mut self, now_ms: u64) -> Result<(), ProtocolError> {
        if self.phase == Phase::Closed {
            return Err(ProtocolError::Closed);
        }
        if now_ms < self.now {
            return Err(ProtocolError::Clock);
        }
        self.now = now_ms;
        if self.phase != Phase::Established && self.now >= self.deadline {
            return Err(ProtocolError::Incompatible);
        }
        if self
            .send
            .iter()
            .any(|ledger| ledger.expired(self.now, self.config.budgets.delivery_timeout_ms))
        {
            return Err(ProtocolError::Limit);
        }
        Ok(())
    }

    fn initiator(&self) -> bool {
        matches!(
            self.config.local_role,
            v5::PeerRole::LocalClient | v5::PeerRole::RemoteClient | v5::PeerRole::Agent
        )
    }

    fn windows(&self) -> v5::ReceiveWindows {
        v5::ReceiveWindows {
            normal_bytes: self.config.budgets.normal_window_bytes,
            event_bytes: self.config.budgets.event_window_bytes,
            bulk_bytes: self.config.budgets.bulk_window_bytes,
        }
    }

    fn negotiate(&mut self, windows: &v5::ReceiveWindows) -> Result<(), ProtocolError> {
        self.config.budgets.normal_window_bytes = self
            .config
            .budgets
            .normal_window_bytes
            .min(windows.normal_bytes);
        self.config.budgets.event_window_bytes = self
            .config
            .budgets
            .event_window_bytes
            .min(windows.event_bytes);
        self.config.budgets.bulk_window_bytes = self
            .config
            .budgets
            .bulk_window_bytes
            .min(windows.bulk_bytes);
        self.send[0] = Ledger::new(self.config.budgets.normal_window_bytes);
        self.send[1] = Ledger::new(self.config.budgets.event_window_bytes);
        self.send[2] = Ledger::new(self.config.budgets.bulk_window_bytes);
        Ok(())
    }

    fn check_size(
        &self,
        frame: &v5::Frame,
        bytes: u64,
        sender: v5::PeerRole,
    ) -> Result<(), ProtocolError> {
        let cap = if sender == v5::PeerRole::Agent
            || matches!(
                if sender == self.config.local_role {
                    self.config.peer_role
                } else {
                    self.config.local_role
                },
                v5::PeerRole::LocalClient | v5::PeerRole::RemoteClient
            ) {
            limits::SERVER_FRAME_BYTES
        } else {
            limits::CLIENT_FRAME_BYTES
        };
        if bytes > cap {
            return Err(ProtocolError::Limit);
        }
        match frame.body.as_ref().ok_or(ProtocolError::Malformed)? {
            v5::frame::Body::Request(request)
                if request.payload.len() as u64 > limits::INLINE_BODY_BYTES =>
            {
                Err(ProtocolError::Limit)
            }
            v5::frame::Body::Result(result)
                if result
                    .outcome
                    .as_ref()
                    .is_some_and(|outcome| match outcome {
                        v5::result::Outcome::Success(payload)
                        | v5::result::Outcome::Error(payload) => {
                            payload.payload.len() as u64 > limits::INLINE_BODY_BYTES
                        }
                        v5::result::Outcome::AssetMetadata(metadata) => {
                            metadata.metadata.payload.len() as u64 > limits::INLINE_BODY_BYTES
                        }
                    }) =>
            {
                Err(ProtocolError::Limit)
            }
            v5::frame::Body::EventBatch(batch)
                if bytes > limits::EVENT_BATCH_BYTES
                    || batch.events.len() as u64 > limits::EVENT_BATCH_COUNT =>
            {
                Err(ProtocolError::Limit)
            }
            body if classify(body) == 3 && bytes > limits::TINY_FRAME_BYTES => {
                Err(ProtocolError::Limit)
            }
            _ => Ok(()),
        }
    }

    fn admit_received(
        &mut self,
        class: usize,
        ordinal: u64,
        bytes: u64,
    ) -> Result<(), ProtocolError> {
        self.rate(class, bytes, true)?;
        let cap = [
            self.config.budgets.normal_window_bytes,
            self.config.budgets.event_window_bytes,
            self.config.budgets.bulk_window_bytes,
            self.config.budgets.tiny_queue_bytes,
        ][class];
        let receive = &mut self.receive[class];
        if receive.last.checked_add(1) != Some(ordinal) {
            return Err(ProtocolError::Malformed);
        }
        if receive
            .bytes
            .values()
            .map(|record| record.bytes)
            .sum::<u64>()
            .checked_add(bytes)
            .is_none_or(|total| total > cap)
        {
            return Err(ProtocolError::Limit);
        }
        if class == 3 && receive.bytes.len() >= self.config.budgets.tiny_queue_count {
            return Err(ProtocolError::Limit);
        }
        receive.last = ordinal;
        receive.bytes.insert(
            ordinal,
            Received {
                bytes,
                consumed: false,
                charge: bytes,
            },
        );
        Ok(())
    }

    fn rate(&mut self, class: usize, bytes: u64, incoming: bool) -> Result<(), ProtocolError> {
        if class != 0 && class != 3 {
            return Ok(());
        }
        let direction = usize::from(incoming);
        let rate = if class == 3 {
            &mut self.tiny_rates[direction]
        } else {
            &mut self.normal_rates[direction]
        };
        while rate.front().is_some_and(|(time, _)| {
            self.now.saturating_sub(*time) >= self.config.budgets.rate_window_ms
        }) {
            rate.pop_front();
        }
        let sender = if incoming {
            self.config.peer_role
        } else {
            self.config.local_role
        };
        let cap = if class == 3 {
            self.config.budgets.tiny_rate
        } else if matches!(
            sender,
            v5::PeerRole::LocalClient | v5::PeerRole::RemoteClient
        ) {
            self.config.budgets.client_rate
        } else {
            self.config.budgets.agent_rate
        };
        if rate.len() >= cap
            || class == 3
                && rate
                    .iter()
                    .map(|entry| entry.1)
                    .sum::<u64>()
                    .checked_add(bytes)
                    .is_none_or(|total| total > self.config.budgets.tiny_rate_bytes)
        {
            return Err(ProtocolError::Limit);
        }
        rate.push_back((self.now, bytes));
        Ok(())
    }

    fn tiny_room(&self) -> bool {
        self.queues[3].len()
            + usize::from(
                self.prepared
                    .as_ref()
                    .is_some_and(|record| record.class == 3),
            )
            + self.send[3].outstanding_count()
            < self.config.budgets.tiny_queue_count
            && self.queued_bytes[3] + self.send[3].outstanding_bytes() + limits::TINY_FRAME_BYTES
                <= self.config.budgets.tiny_queue_bytes
    }

    fn queued_event_count(&self) -> usize {
        self.queues[1]
            .iter()
            .filter_map(|queued| {
                if let Some(v5::frame::Body::EventBatch(batch)) = &queued.frame.body {
                    Some(batch.events.len())
                } else {
                    None
                }
            })
            .sum::<usize>()
            + self
                .prepared
                .as_ref()
                .map_or(0, |record| record.event_count)
    }

    fn relay_delivery_bytes(&self) -> u64 {
        self.queued_bytes[1]
            + self.queued_bytes[2]
            + self.send[1].outstanding_bytes()
            + self.send[2].outstanding_bytes()
    }

    fn queue_ping(&mut self) -> Result<(), ProtocolError> {
        if self.ping.is_some()
            || self.prepared.as_ref().is_some_and(|record| record.ping)
            || self.queues[3].iter().any(|queued| {
                matches!(
                    &queued.frame.body,
                    Some(v5::frame::Body::Control(v5::Control {
                        kind: Some(v5::control::Kind::Ping(_))
                    }))
                )
            })
        {
            return Ok(());
        }
        let id = self.next_ping;
        self.next_ping = id.checked_add(1).ok_or(ProtocolError::Limit)?;
        self.enqueue_control(v5::control::Kind::Ping(v5::Ping { id }))
    }

    fn enqueue_control(&mut self, kind: v5::control::Kind) -> Result<(), ProtocolError> {
        self.queue_reserved(
            v5::frame::Body::Control(v5::Control { kind: Some(kind) }),
            limits::TINY_FRAME_BYTES,
            self.now,
        )
    }

    fn queue_reserved(
        &mut self,
        body: v5::frame::Body,
        bytes: u64,
        ready_at: u64,
    ) -> Result<(), ProtocolError> {
        if !matches!(self.phase, Phase::Established | Phase::Confirm) {
            return Err(ProtocolError::Incompatible);
        }
        let class = classify(&body);
        if !boundary::allowed(&body, self.config.local_role)? {
            return Err(ProtocolError::Direction);
        }
        let frame = v5::Frame {
            revision: 5,
            connection_epoch: Some(self.epoch.clone()),
            ledger: Some((class + 1) as i32),
            delivery_ordinal: None,
            tiny_consumed_through: None,
            body: Some(body),
        };
        self.check_size(&frame, bytes, self.config.local_role)?;
        if bytes == 0 || bytes > self.send[class].available() + self.send[class].outstanding_bytes()
        {
            return Err(ProtocolError::Limit);
        }
        let queue_cap = [
            self.config.budgets.normal_queue_bytes,
            self.config.budgets.event_queue_bytes,
            self.config.budgets.bulk_window_bytes,
            self.config.budgets.tiny_queue_bytes,
        ][class];
        if self.queued_bytes[class]
            .checked_add(bytes)
            .is_none_or(|total| total > queue_cap)
        {
            return Err(ProtocolError::Limit);
        }
        if class == 3
            && (!self.tiny_room()
                || self.queued_bytes[3] + self.send[3].outstanding_bytes() + bytes
                    > self.config.budgets.tiny_queue_bytes)
        {
            return Err(ProtocolError::Limit);
        }
        if class == 1
            && self.queued_event_count()
                + match &frame.body {
                    Some(v5::frame::Body::EventBatch(batch)) => batch.events.len(),
                    _ => 0,
                }
                > self.config.budgets.event_queue_count
        {
            return Err(ProtocolError::Limit);
        }
        if self.config.peer_role == v5::PeerRole::RemoteClient
            && self.relay_delivery_bytes() + if class == 1 || class == 2 { bytes } else { 0 }
                > self.config.budgets.relay_peer_bytes
        {
            return Err(ProtocolError::Limit);
        }
        if !self.reserve(bytes) {
            return Err(ProtocolError::Limit);
        }
        let ticket = if matches!(frame.body, Some(v5::frame::Body::EventBatch(_))) {
            self.event_ticket = self
                .event_ticket
                .checked_add(1)
                .ok_or(ProtocolError::Limit)?;
            Some(self.event_ticket)
        } else {
            None
        };
        let event_key = match &frame.body {
            Some(v5::frame::Body::EventBatch(batch)) => Some(match &batch.scope.target {
                Some(v5::scope::Target::Session(session)) => session.clone(),
                _ => batch.subscription_id.clone(),
            }),
            _ => None,
        };
        self.queued_bytes[class] += bytes;
        self.queues[class].push_back(Queued {
            frame,
            bytes,
            ready_at,
            ticket,
            event_fence: None,
            event_key,
        });
        Ok(())
    }

    fn select(&mut self) -> Option<(usize, usize)> {
        if self.eligible(3, 0) {
            return Some((3, 0));
        }
        if let Some(position) =
            (0..self.queues[0].len()).find(|position| self.eligible(0, *position))
        {
            return Some((0, position));
        }
        let event = self.rotated(1, self.event_rotation.as_deref());
        let bulk = self.rotated(2, self.bulk_rotation.as_deref());
        if let Some(position) = event.filter(|_| bulk.is_none() || self.event_weight < 2) {
            return Some((1, position));
        }
        if let Some(position) = bulk {
            return Some((2, position));
        }
        None
    }

    fn eligible(&self, class: usize, position: usize) -> bool {
        self.queues[class].get(position).is_some_and(|queued| {
            if let Some(fence) = queued.event_fence
                && (self.queues[1].iter().any(|record| {
                    record.event_key == queued.event_key
                        && record.ticket.is_some_and(|ticket| ticket <= fence)
                }) || self.handed_events.values().any(|(ticket, key)| {
                    *ticket <= fence && Some(key) == queued.event_key.as_ref()
                }))
            {
                return false;
            }
            if matches!(
                queued.frame.body,
                Some(v5::frame::Body::Hello(_) | v5::frame::Body::Ready(_))
            ) {
                return queued.ready_at <= self.now;
            }
            if queued.ready_at > self.now || queued.bytes > self.send[class].available() {
                return false;
            }
            match &queued.frame.body {
                Some(v5::frame::Body::StreamEnd(end)) => {
                    self.stream_end_ready(&end.subscription_id)
                }
                Some(v5::frame::Body::BulkPiece(piece)) => self
                    .outgoing_transfers
                    .get(&piece.transfer_id)
                    .is_some_and(|transfer| transfer.started),
                Some(v5::frame::Body::BulkEnd(end)) => self
                    .outgoing_transfers
                    .get(&end.transfer_id)
                    .is_some_and(|transfer| {
                        transfer.started && transfer.handed_pieces == transfer.index
                    }),
                _ => true,
            }
        })
    }

    fn stream_end_ready(&self, subscription_id: &str) -> bool {
        let Some(subscription) = self.sending_subscriptions.get(subscription_id) else {
            return false;
        };
        !self.queues[0].iter().any(|record| matches!(&record.frame.body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::ResyncRequired(resync)) })) if resync.scope == subscription.scope))
            && !self.resync_fences.values().any(|scope| *scope == subscription.scope)
    }

    fn owner(&self, class: usize, position: usize) -> Option<String> {
        match self.queues[class].get(position)?.frame.body.as_ref()? {
            v5::frame::Body::EventBatch(batch) => Some(match &batch.scope.target {
                Some(v5::scope::Target::Session(session)) => session.clone(),
                _ => batch.subscription_id.clone(),
            }),
            v5::frame::Body::StreamEnd(end) => Some(
                match &self
                    .sending_subscriptions
                    .get(&end.subscription_id)?
                    .scope
                    .target
                {
                    Some(v5::scope::Target::Session(session)) => session.clone(),
                    _ => end.subscription_id.clone(),
                },
            ),
            v5::frame::Body::BulkPiece(piece) => Some(piece.transfer_id.clone()),
            _ => None,
        }
    }

    fn rotated(&self, class: usize, previous: Option<&str>) -> Option<usize> {
        let mut seen = BTreeSet::new();
        let eligible = (0..self.queues[class].len())
            .filter(|position| {
                let Some(owner) = self.owner(class, *position) else {
                    return false;
                };
                seen.insert(owner) && self.eligible(class, *position)
            })
            .collect::<Vec<_>>();
        eligible
            .iter()
            .copied()
            .find(|position| self.owner(class, *position).as_deref() != previous)
            .or_else(|| eligible.first().copied())
    }

    fn descriptor(&self, operation_id: u32) -> Result<&v5::OperationDescriptor, ProtocolError> {
        self.descriptors
            .iter()
            .find(|descriptor| descriptor.operation_id == operation_id)
            .ok_or(ProtocolError::Malformed)
    }

    fn request_contract(
        &self,
        descriptor: &v5::OperationDescriptor,
        scope: &v5::Scope,
        payload: &[u8],
        role: v5::PeerRole,
    ) -> Result<(), ProtocolError> {
        if !descriptor.roles.contains(&(role as i32)) {
            return Err(ProtocolError::Direction);
        }
        if payload.len() as u64 > limits::INLINE_BODY_BYTES {
            return Err(ProtocolError::Limit);
        }
        let kind = match scope.target.as_ref().ok_or(ProtocolError::Malformed)? {
            v5::scope::Target::Machine(_) => v5::ScopeKind::Machine,
            v5::scope::Target::Location(_) => v5::ScopeKind::Location,
            v5::scope::Target::Session(_) => v5::ScopeKind::Session,
            v5::scope::Target::Form(_) => v5::ScopeKind::Form,
            v5::scope::Target::Workspace(_) => v5::ScopeKind::Workspace,
            v5::scope::Target::Global(_) => v5::ScopeKind::Global,
            v5::scope::Target::GlobalForm(_) => v5::ScopeKind::GlobalForm,
        };
        let scopes = descriptor
            .role_scopes
            .iter()
            .find(|rule| rule.role == role as i32);
        if !scopes.map_or(kind as i32 == descriptor.scope, |rule| {
            rule.scopes.contains(&(kind as i32))
        }) {
            return Err(ProtocolError::Direction);
        }
        if role == v5::PeerRole::RemoteClient && !self.authorized(scope) {
            return Err(ProtocolError::Direction);
        }
        if self.config.local_role == v5::PeerRole::Relay {
            return Ok(());
        }
        crate::validate_binary(&descriptor.request_type, payload).map_err(wire_error)
    }

    fn authorized(&self, scope: &v5::Scope) -> bool {
        match &scope.target {
            Some(v5::scope::Target::Session(session)) => {
                self.config.authorized_sessions.contains(session)
            }
            Some(v5::scope::Target::Workspace(workspace)) => {
                self.config.authorized_workspaces.contains(workspace)
            }
            Some(v5::scope::Target::Machine(_)) => true,
            _ => false,
        }
    }

    fn result_contract(&self, result: &v5::Result, operation_id: u32) -> Result<(), ProtocolError> {
        let descriptor = self.descriptor(operation_id)?;
        if result.operation_id != operation_id || result.settlement != descriptor.settlement {
            return Err(ProtocolError::Malformed);
        }
        let payload = match result.outcome.as_ref().ok_or(ProtocolError::Malformed)? {
            v5::result::Outcome::Success(payload) => {
                if descriptor.streaming == v5::Streaming::AssetBulk as i32 {
                    return Err(ProtocolError::Malformed);
                }
                if payload.type_name != descriptor.result_type {
                    return Err(ProtocolError::Malformed);
                }
                payload
            }
            v5::result::Outcome::Error(payload) => {
                if !descriptor.error_types.contains(&payload.type_name) {
                    return Err(ProtocolError::Malformed);
                }
                payload
            }
            v5::result::Outcome::AssetMetadata(metadata) => {
                if descriptor.streaming != v5::Streaming::AssetBulk as i32 {
                    return Err(ProtocolError::Malformed);
                }
                return crate::asset::validate_metadata(
                    metadata,
                    &descriptor.result_type,
                    self.config.local_role == v5::PeerRole::Relay,
                )
                .map_err(wire_error);
            }
        };
        if payload.payload.len() as u64 > limits::INLINE_BODY_BYTES {
            return Err(ProtocolError::Limit);
        }
        if self.config.local_role == v5::PeerRole::Relay {
            return Ok(());
        }
        crate::validate_binary(&payload.type_name, &payload.payload).map_err(wire_error)
    }

    fn late_id(&self, request_id: &str) -> Result<(), ProtocolError> {
        if request_id
            .parse::<u64>()
            .ok()
            .is_some_and(|id| id > 0 && id < self.next_request && id.to_string() == request_id)
        {
            return Ok(());
        }
        Err(ProtocolError::Malformed)
    }

    fn bulk_contract(&self, start: &v5::BulkStart, incoming: bool) -> Result<(), ProtocolError> {
        let pending = if incoming {
            &self.requests
        } else {
            &self.incoming
        }
        .get(&start.request_id)
        .ok_or(ProtocolError::Malformed)?;
        if !pending.sent || pending.operation_id != start.operation_id {
            return Err(ProtocolError::Malformed);
        }
        let descriptor = self.descriptor(start.operation_id)?;
        let kind = match v5::Streaming::try_from(descriptor.streaming)
            .map_err(|_| ProtocolError::Malformed)?
        {
            v5::Streaming::TypedBulk => v5::ContentKind::TypedMessage,
            v5::Streaming::AssetBulk => v5::ContentKind::Asset,
            _ => return Err(ProtocolError::Malformed),
        };
        if start.content_kind != kind as i32
            || start.type_name != descriptor.result_type
            || start.transfer_id.is_empty()
        {
            return Err(ProtocolError::Malformed);
        }
        if kind == v5::ContentKind::Asset
            && (pending.asset_count != Some(start.byte_count)
                || u64::from(start.chunk_count)
                    != start.byte_count.div_ceil(limits::BULK_PIECE_BYTES))
        {
            return Err(ProtocolError::Malformed);
        }
        let transfers = if incoming {
            &self.transfers
        } else {
            &self.outgoing_transfers
        };
        if transfers.len() >= limits::BULK_TRANSFERS as usize
            || transfers.contains_key(&start.transfer_id)
            || transfers
                .values()
                .any(|transfer| transfer.start.request_id == start.request_id)
        {
            return Err(ProtocolError::Limit);
        }
        if start.byte_count > limits::BULK_MESSAGE_BYTES
            || (start.chunk_count == 0
                && !(kind == v5::ContentKind::Asset && start.byte_count == 0))
            || u64::from(start.chunk_count) > limits::BULK_PIECES
            || start.byte_count > u64::from(start.chunk_count) * limits::BULK_PIECE_BYTES
        {
            return Err(ProtocolError::Limit);
        }
        if incoming
            && self.config.local_role != v5::PeerRole::Relay
            && transfers
                .values()
                .map(|transfer| transfer.start.byte_count)
                .sum::<u64>()
                .checked_add(start.byte_count)
                .is_none_or(|total| total > limits::BULK_MESSAGE_BYTES)
        {
            return Err(ProtocolError::Limit);
        }
        Ok(())
    }

    fn piece_contract(&self, piece: &v5::BulkPiece, incoming: bool) -> Result<(), ProtocolError> {
        let transfer = if incoming {
            &self.transfers
        } else {
            &self.outgoing_transfers
        }
        .get(&piece.transfer_id)
        .ok_or(ProtocolError::Malformed)?;
        if piece.index != transfer.index
            || (transfer.start.content_kind == v5::ContentKind::Asset as i32
                && piece.data.len() as u64
                    != (transfer.start.byte_count - transfer.received)
                        .min(limits::BULK_PIECE_BYTES))
            || piece.offset != transfer.received
            || piece.index >= transfer.start.chunk_count
            || piece.data.len() as u64 > limits::BULK_PIECE_BYTES
            || transfer
                .received
                .checked_add(piece.data.len() as u64)
                .is_none_or(|total| total > transfer.start.byte_count)
        {
            return Err(ProtocolError::Malformed);
        }
        Ok(())
    }

    fn end_contract(&self, end: &v5::BulkEnd, incoming: bool) -> Result<(), ProtocolError> {
        let transfer = if incoming {
            &self.transfers
        } else {
            &self.outgoing_transfers
        }
        .get(&end.transfer_id)
        .ok_or(ProtocolError::Malformed)?;
        if end.byte_count != transfer.received {
            return Err(ProtocolError::Malformed);
        }
        match end.outcome.as_ref().ok_or(ProtocolError::Malformed)? {
            v5::bulk_end::Outcome::Success(_) => {
                if transfer.received != transfer.start.byte_count
                    || transfer.index != transfer.start.chunk_count
                {
                    return Err(ProtocolError::Malformed);
                }
            }
            v5::bulk_end::Outcome::Error(error) => {
                if !self
                    .descriptor(transfer.start.operation_id)?
                    .error_types
                    .contains(&error.type_name)
                {
                    return Err(ProtocolError::Malformed);
                }
                if self.config.local_role != v5::PeerRole::Relay {
                    crate::validate_binary(&error.type_name, &error.payload).map_err(wire_error)?;
                }
            }
        }
        Ok(())
    }

    fn cancel_incoming(&mut self, cancel: &v5::Cancel) -> Result<Vec<Decision>, ProtocolError> {
        let target = cancel.target.as_ref().ok_or(ProtocolError::Malformed)?;
        let request_id = match target {
            v5::cancel::Target::RequestId(id) => id.clone(),
            v5::cancel::Target::TransferId(id) => {
                let Some(transfer) = self.outgoing_transfers.get(id) else {
                    return Ok(Vec::new());
                };
                transfer.start.request_id.clone()
            }
        };
        let Some(pending) = self.incoming.get(&request_id) else {
            return Ok(Vec::new());
        };
        let mutation =
            self.descriptor(pending.operation_id)?.mutation == v5::MutationClass::Mutation as i32;
        self.incoming.remove(&request_id);
        self.remove_output(&request_id, None)?;
        Ok(vec![Decision::CancelWork {
            target: target.clone(),
            mutation,
        }])
    }

    fn remove_output(
        &mut self,
        request_id: &str,
        transfer_id: Option<&str>,
    ) -> Result<(), ProtocolError> {
        let ids = self
            .outgoing_transfers
            .iter()
            .filter(|(_, transfer)| transfer.start.request_id == request_id)
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>();
        let mut released = 0;
        for (index, queue) in self.queues.iter_mut().enumerate() {
            let before = queue.iter().map(|record| record.bytes).sum::<u64>();
            queue.retain(|queued| match &queued.frame.body {
                Some(v5::frame::Body::Request(request)) => request.request_id != request_id,
                Some(v5::frame::Body::Result(result)) => result.request_id != request_id,
                Some(v5::frame::Body::BulkStart(start)) => start.request_id != request_id,
                Some(v5::frame::Body::BulkPiece(piece)) => {
                    !ids.contains(&piece.transfer_id)
                        && transfer_id != Some(piece.transfer_id.as_str())
                }
                Some(v5::frame::Body::BulkEnd(end)) => {
                    !ids.contains(&end.transfer_id) && transfer_id != Some(end.transfer_id.as_str())
                }
                _ => true,
            });
            let removed = before - queue.iter().map(|queued| queued.bytes).sum::<u64>();
            self.queued_bytes[index] -= removed;
            released += removed;
        }
        self.outgoing_transfers
            .retain(|_, transfer| transfer.start.request_id != request_id);
        if self.prepared.as_ref().is_some_and(|record| {
            record.request_id.as_deref() == Some(request_id)
                || record
                    .transfer_id
                    .as_ref()
                    .is_some_and(|id| ids.contains(id) || transfer_id == Some(id.as_str()))
        }) {
            let record = self.prepared.take().ok_or(ProtocolError::Unknown)?;
            self.queued_bytes[record.class] -= record.bytes;
            released += record.bytes;
        }
        self.release(released)
    }

    pub fn disconnect(&mut self, service_restart: bool) -> Vec<Decision> {
        let mut decisions = self.close(ProtocolError::Closed);
        if let Some(Decision::Closed(close)) = decisions.last_mut() {
            close.code = if service_restart { 1012 } else { 1000 };
        }
        decisions
    }

    pub fn close(&mut self, error: ProtocolError) -> Vec<Decision> {
        if self.phase == Phase::Closed {
            return Vec::new();
        }
        let code = if self.phase != Phase::Established {
            1008
        } else {
            1002
        };
        self.phase = Phase::Closed;
        let forwarded = std::mem::take(&mut self.forwarded_tickets)
            .into_iter()
            .map(|ticket| Decision::EventBatchReleased {
                ticket,
                consumed: false,
            })
            .collect::<Vec<_>>();
        let charge = std::mem::take(&mut self.owned_charge);
        let released = self.reservation.borrow_mut().release(charge);
        debug_assert!(released.is_ok());
        self.admissions.clear();
        self.prepared = None;
        let decisions =
            std::mem::take(&mut self.requests)
                .into_iter()
                .map(|(request_id, pending)| Decision::Settled {
                    request_id,
                    outcome: if pending.sent {
                        Outcome::Unknown
                    } else {
                        Outcome::Unsent
                    },
                });
        let mut decisions = decisions.collect::<Vec<_>>();
        decisions.extend(forwarded);
        decisions.extend(self.incoming.iter().map(|(id, pending)| {
            Decision::CancelWork {
                target: v5::cancel::Target::RequestId(id.clone()),
                mutation: self
                    .descriptors
                    .iter()
                    .find(|descriptor| descriptor.operation_id == pending.operation_id)
                    .is_some_and(|descriptor| {
                        descriptor.mutation == v5::MutationClass::Mutation as i32
                    }),
            }
        }));
        self.incoming.clear();
        self.transfers.clear();
        self.outgoing_transfers.clear();
        self.subscriptions.clear();
        self.sending_subscriptions.clear();
        self.relay_clients.clear();
        self.relay_identities.clear();
        self.resync_fences.clear();
        self.handed_events.clear();
        self.awaiting_subscription.clear();
        self.queues.iter_mut().for_each(VecDeque::clear);
        self.queued_bytes = [0; 4];
        self.send = std::array::from_fn(|_| Ledger::new(0));
        self.receive = std::array::from_fn(|_| ReceiveLedger::default());
        decisions.push(Decision::Closed(Close {
            code,
            category: error,
        }));
        decisions
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let released = self.reservation.borrow_mut().release(self.owned_charge);
        debug_assert!(released.is_ok());
    }
}

fn handshake(body: v5::frame::Body, epoch: Option<String>) -> v5::Frame {
    v5::Frame {
        revision: 5,
        connection_epoch: epoch,
        ledger: None,
        delivery_ordinal: None,
        tiny_consumed_through: None,
        body: Some(body),
    }
}

fn digest() -> Vec<u8> {
    crate::CONTRACT_DIGEST
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| {
            let digit = |byte: u8| {
                if byte.is_ascii_digit() {
                    byte - b'0'
                } else {
                    byte - b'a' + 10
                }
            };
            digit(pair[0]) * 16 + digit(pair[1])
        })
        .collect()
}

fn classify(body: &v5::frame::Body) -> usize {
    match body {
        v5::frame::Body::EventBatch(_) | v5::frame::Body::StreamEnd(_) => 1,
        v5::frame::Body::BulkPiece(_) => 2,
        v5::frame::Body::Control(v5::Control {
            kind:
                Some(
                    v5::control::Kind::Ping(_)
                    | v5::control::Kind::Pong(_)
                    | v5::control::Kind::Credit(_)
                    | v5::control::Kind::Cancel(_),
                ),
        }) => 3,
        _ => 0,
    }
}

fn class_index(class: i32) -> Result<usize, ProtocolError> {
    v5::LedgerClass::try_from(class)
        .map(|class| class as usize - 1)
        .map_err(|_| ProtocolError::Malformed)
}

fn wire_error(error: crate::WireError) -> ProtocolError {
    match error.0 {
        "connection epoch" | "Ready epoch" | "Hello epoch" => ProtocolError::Epoch,
        "revision" | "handshake identity" | "handshake timeout" | "handshake order"
        | "Ready confirmation" => ProtocolError::Incompatible,
        "direction" | "authenticated peer role" | "peer roles" => ProtocolError::Direction,
        "frame byte limit"
        | "handshake byte limit"
        | "tiny byte limit"
        | "window limit"
        | "request bounds"
        | "result bounds"
        | "event batch bounds"
        | "bulk announcement bounds"
        | "bulk piece bounds"
        | "bulk end bounds" => ProtocolError::Limit,
        _ => ProtocolError::Malformed,
    }
}
