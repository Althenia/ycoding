use super::{Connection, Decision, Phase, ProtocolError, Queued, classify, digest};
use crate::{limits, v5};
use std::rc::Rc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Send,
    Receive,
}

pub struct Incoming {
    owner: Rc<()>,
    id: u64,
    byte_length: u64,
}
impl Incoming {
    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }
}

pub struct Prepared {
    owner: Rc<()>,
    id: u64,
    frame: v5::Frame,
    reserved_bytes: u64,
}
impl Prepared {
    pub fn frame(&self) -> &v5::Frame {
        &self.frame
    }
    pub fn reserved_bytes(&self) -> u64 {
        self.reserved_bytes
    }
}

pub(super) struct PreparedState {
    pub id: u64,
    pub bytes: u64,
    pub class: usize,
    pub ready_at: u64,
    pub authority: u64,
    pub request_id: Option<String>,
    pub transfer_id: Option<String>,
    pub subscription_id: Option<String>,
    pub ticket: Option<u64>,
    pub event_fence: Option<u64>,
    pub event_key: Option<String>,
    pub event_count: usize,
    pub ping: bool,
}

impl Connection {
    pub fn admit_incoming(&mut self, byte_length: u64) -> Option<Incoming> {
        if self.phase == Phase::Closed {
            return None;
        }
        let handshake = matches!(self.phase, Phase::Initial | Phase::Hello);
        if byte_length == 0
            || byte_length > self.frame_cap(self.config.peer_role)
            || handshake
                && (byte_length > limits::HANDSHAKE_BYTES
                    || self
                        .owned_charge
                        .checked_add(byte_length)
                        .is_none_or(|total| total > limits::HANDSHAKE_RETAINED_BYTES))
            || self.next_token == u64::MAX
            || !self.reserve(byte_length)
        {
            let decisions = self.close(ProtocolError::Limit);
            self.notifications.extend(decisions);
            return None;
        }
        let id = self.next_token;
        self.next_token += 1;
        self.admissions
            .insert(id, (byte_length, self.authority_version));
        Some(Incoming {
            owner: self.owner.clone(),
            id,
            byte_length,
        })
    }

    pub fn reject_incoming(&mut self, token: &Incoming) -> Result<Vec<Decision>, ProtocolError> {
        self.require_incoming(token)?;
        self.admissions.remove(&token.id);
        self.release(token.byte_length)?;
        Ok(self.close(ProtocolError::Malformed))
    }

    pub fn accept_incoming(
        &mut self,
        token: &Incoming,
        frame: v5::Frame,
        now_ms: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.require_incoming(token)?;
        let (_, authority) = self
            .admissions
            .remove(&token.id)
            .ok_or(ProtocolError::Unknown)?;
        if authority != self.authority_version {
            return self.revoke(4403);
        }
        let handshake = matches!(self.phase, Phase::Initial | Phase::Hello);
        let decisions = self.receive_reserved(frame, token.byte_length, now_ms);
        if handshake && self.phase != Phase::Closed {
            self.release(token.byte_length)?;
        }
        Ok(decisions)
    }

    fn require_incoming(&self, token: &Incoming) -> Result<(), ProtocolError> {
        if !Rc::ptr_eq(&token.owner, &self.owner) || !self.admissions.contains_key(&token.id) {
            return Err(ProtocolError::Unknown);
        }
        Ok(())
    }

    pub fn prepare_handoff(&mut self, now_ms: u64) -> Option<Prepared> {
        let decisions = self.advance(now_ms);
        self.notifications.extend(decisions);
        if self.phase == Phase::Closed || self.prepared.is_some() {
            return None;
        }
        let (class, position) = self.select()?;
        let record = self.queues[class].remove(position)?;
        let id = self.next_token;
        if id == u64::MAX {
            self.queues[class].insert(position, record);
            let decisions = self.close(ProtocolError::Limit);
            self.notifications.extend(decisions);
            return None;
        }
        self.next_token += 1;
        let mut frame = record.frame;
        let handshake = matches!(
            frame.body,
            Some(v5::frame::Body::Hello(_) | v5::frame::Body::Ready(_))
        );
        if !handshake {
            frame.connection_epoch = Some(self.epoch.clone());
            frame.ledger = Some((class + 1) as i32);
            frame.delivery_ordinal = Some(self.send[class].next_ordinal());
            frame.tiny_consumed_through = Some(self.receive[3].consumed);
        }
        let request_id = match frame.body.as_ref() {
            Some(v5::frame::Body::Request(request)) => Some(request.request_id.clone()),
            Some(v5::frame::Body::Result(result)) => Some(result.request_id.clone()),
            Some(v5::frame::Body::BulkStart(start)) => Some(start.request_id.clone()),
            _ => None,
        };
        let transfer_id = match frame.body.as_ref() {
            Some(v5::frame::Body::BulkStart(start)) => Some(start.transfer_id.clone()),
            Some(v5::frame::Body::BulkPiece(piece)) => Some(piece.transfer_id.clone()),
            Some(v5::frame::Body::BulkEnd(end)) => Some(end.transfer_id.clone()),
            _ => None,
        };
        let subscription_id = match frame.body.as_ref() {
            Some(v5::frame::Body::EventBatch(batch)) => Some(batch.subscription_id.clone()),
            Some(v5::frame::Body::StreamEnd(end)) => Some(end.subscription_id.clone()),
            _ => None,
        };
        let event_count = match &frame.body {
            Some(v5::frame::Body::EventBatch(batch)) => batch.events.len(),
            _ => 0,
        };
        let ping = matches!(
            &frame.body,
            Some(v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::Ping(_))
            }))
        );
        self.prepared = Some(PreparedState {
            id,
            class,
            bytes: record.bytes,
            ready_at: record.ready_at,
            authority: self.authority_version,
            request_id,
            transfer_id,
            subscription_id,
            ticket: record.ticket,
            event_fence: record.event_fence,
            event_key: record.event_key,
            event_count,
            ping,
        });
        Some(Prepared {
            owner: self.owner.clone(),
            id,
            frame,
            reserved_bytes: record.bytes,
        })
    }

    pub fn abort_prepared(&mut self, token: Prepared) -> Result<(), ProtocolError> {
        self.require_prepared(&token)?;
        let state = self.prepared.take().ok_or(ProtocolError::Unknown)?;
        self.queues[state.class].push_front(Queued {
            frame: token.frame,
            bytes: state.bytes,
            ready_at: state.ready_at,
            ticket: state.ticket,
            event_fence: state.event_fence,
            event_key: state.event_key,
        });
        Ok(())
    }

    pub fn handoff(
        &mut self,
        token: Prepared,
        exact_bytes: u64,
        now_ms: u64,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.require_prepared(&token)?;
        let state = self.prepared.as_ref().ok_or(ProtocolError::Unknown)?;
        if state.authority != self.authority_version {
            return self.revoke(4403);
        }
        if let Err(error) = self.time(now_ms) {
            return Ok(self.close(error));
        }
        if exact_bytes == 0 || exact_bytes > token.reserved_bytes {
            return Ok(self.close(ProtocolError::Malformed));
        }
        let class = classify(token.frame.body.as_ref().ok_or(ProtocolError::Malformed)?);
        let handshake = matches!(
            token.frame.body,
            Some(v5::frame::Body::Hello(_) | v5::frame::Body::Ready(_))
        );
        if let Err(error) = self.check_size(&token.frame, exact_bytes, self.config.local_role) {
            return Ok(self.close(error));
        }
        if let Some(v5::frame::Body::StreamEnd(end)) = &token.frame.body
            && !self.stream_end_ready(&end.subscription_id)
        {
            self.abort_prepared(token)?;
            return Ok(Vec::new());
        }
        if !handshake {
            if let Err(error) = self.rate(class, exact_bytes, false) {
                return Ok(self.close(error));
            }
            if self.send[class].hand(exact_bytes, self.now).is_err() {
                return Ok(self.close(ProtocolError::Limit));
            }
        }
        let state = self.prepared.take().ok_or(ProtocolError::Unknown)?;
        if let Some(ticket) = state.ticket
            && let Some(key) = state.event_key
        {
            self.handed_events.insert(
                token
                    .frame
                    .delivery_ordinal
                    .ok_or(ProtocolError::Malformed)?,
                (ticket, key),
            );
        }
        self.queued_bytes[class] -= token.reserved_bytes;
        self.release(if handshake {
            token.reserved_bytes
        } else {
            token.reserved_bytes - exact_bytes
        })?;
        self.mark_handed(&token.frame)?;
        Ok(vec![Decision::Send(token.frame)])
    }

    fn require_prepared(&self, token: &Prepared) -> Result<(), ProtocolError> {
        if !Rc::ptr_eq(&token.owner, &self.owner)
            || self
                .prepared
                .as_ref()
                .is_none_or(|state| state.id != token.id)
        {
            return Err(ProtocolError::Unknown);
        }
        Ok(())
    }

    pub fn take_decisions(&mut self) -> Vec<Decision> {
        std::mem::take(&mut self.notifications)
    }

    pub fn update_authority(
        &mut self,
        version: u64,
        authorized: bool,
        now_ms: u64,
        code: u16,
    ) -> Result<Vec<Decision>, ProtocolError> {
        if version <= self.authority_version || (code != 4401 && code != 4403) {
            return Err(ProtocolError::Direction);
        }
        if let Err(error) = self.time(now_ms) {
            return Ok(self.close(error));
        }
        self.authority_version = version;
        if !authorized {
            return self.revoke(code);
        }
        Ok(Vec::new())
    }

    pub(super) fn reserve(&mut self, bytes: u64) -> bool {
        let reserved = self.reservation.borrow_mut().reserve(bytes);
        if reserved {
            self.owned_charge += bytes;
        }
        reserved
    }

    pub(super) fn release(&mut self, bytes: u64) -> Result<(), ProtocolError> {
        if bytes > self.owned_charge {
            return Err(ProtocolError::Limit);
        }
        self.reservation.borrow_mut().release(bytes)?;
        self.owned_charge -= bytes;
        Ok(())
    }

    pub(super) fn queue_handshake(&mut self, frame: v5::Frame) -> Result<(), ProtocolError> {
        if self
            .owned_charge
            .checked_add(limits::HANDSHAKE_BYTES)
            .is_none_or(|total| total > limits::HANDSHAKE_RETAINED_BYTES)
            || !self.reserve(limits::HANDSHAKE_BYTES)
        {
            return Err(ProtocolError::Limit);
        }
        self.queued_bytes[0] += limits::HANDSHAKE_BYTES;
        self.queues[0].push_back(Queued {
            frame,
            bytes: limits::HANDSHAKE_BYTES,
            ready_at: self.now,
            ticket: None,
            event_fence: None,
            event_key: None,
        });
        Ok(())
    }

    pub(super) fn frame_cap(&self, sender: v5::PeerRole) -> u64 {
        let receiver = if sender == self.config.local_role {
            self.config.peer_role
        } else {
            self.config.local_role
        };
        if sender == v5::PeerRole::Agent
            || matches!(
                receiver,
                v5::PeerRole::LocalClient | v5::PeerRole::RemoteClient
            )
        {
            limits::SERVER_FRAME_BYTES
        } else {
            limits::CLIENT_FRAME_BYTES
        }
    }

    pub(super) fn envelope(
        &self,
        frame: &v5::Frame,
        sender: v5::PeerRole,
    ) -> Result<(), ProtocolError> {
        if frame.revision != limits::REVISION as u32 {
            return Err(ProtocolError::Incompatible);
        }
        let body = frame.body.as_ref().ok_or(ProtocolError::Malformed)?;
        if !allowed(body, sender)? {
            return Err(ProtocolError::Direction);
        }
        if matches!(body, v5::frame::Body::Hello(_) | v5::frame::Body::Ready(_)) {
            if frame.ledger.is_some()
                || frame.delivery_ordinal.is_some()
                || frame.tiny_consumed_through.is_some()
            {
                return Err(ProtocolError::Malformed);
            }
            let (revision, hash, role, windows) = match body {
                v5::frame::Body::Hello(hello) => (
                    hello.revision,
                    &hello.contract_digest,
                    hello.role,
                    &hello.receive_windows,
                ),
                v5::frame::Body::Ready(ready) => (
                    ready.revision,
                    &ready.contract_digest,
                    ready.role,
                    &ready.receive_windows,
                ),
                _ => return Err(ProtocolError::Malformed),
            };
            if revision != limits::REVISION as u32 || *hash != digest() || role != sender as i32 {
                return Err(ProtocolError::Incompatible);
            }
            if windows.normal_bytes == 0
                || windows.normal_bytes > limits::NORMAL_WINDOW_BYTES
                || windows.event_bytes == 0
                || windows.event_bytes > limits::EVENT_WINDOW_BYTES
                || windows.bulk_bytes == 0
                || windows.bulk_bytes > limits::BULK_WINDOW_BYTES
            {
                return Err(ProtocolError::Limit);
            }
            return Ok(());
        }
        if frame.connection_epoch.as_deref() != Some(self.epoch.as_str()) {
            return Err(ProtocolError::Epoch);
        }
        if frame.ledger != Some((classify(body) + 1) as i32)
            || frame.delivery_ordinal.is_none_or(|ordinal| ordinal == 0)
        {
            return Err(ProtocolError::Malformed);
        }
        Ok(())
    }
}

pub(super) fn allowed(body: &v5::frame::Body, sender: v5::PeerRole) -> Result<bool, ProtocolError> {
    let mask = match body {
        v5::frame::Body::Hello(_) => v5::SenderMask::HelloSenders,
        v5::frame::Body::Ready(_) => v5::SenderMask::ReadySenders,
        v5::frame::Body::Request(_) => v5::SenderMask::RequestSenders,
        v5::frame::Body::Result(_)
        | v5::frame::Body::EventBatch(_)
        | v5::frame::Body::StreamEnd(_) => v5::SenderMask::ResultSenders,
        v5::frame::Body::BulkStart(_)
        | v5::frame::Body::BulkPiece(_)
        | v5::frame::Body::BulkEnd(_) => v5::SenderMask::PingSenders,
        v5::frame::Body::Control(control) => {
            match control.kind.as_ref().ok_or(ProtocolError::Malformed)? {
                v5::control::Kind::Ping(_)
                | v5::control::Kind::Pong(_)
                | v5::control::Kind::Cancel(_)
                | v5::control::Kind::Credit(_)
                | v5::control::Kind::Failure(_) => v5::SenderMask::PingSenders,
                v5::control::Kind::SubscriptionSnapshot(_) | v5::control::Kind::Notice(_) => {
                    v5::SenderMask::SubscriptionSnapshotSenders
                }
                v5::control::Kind::Priority(_) => v5::SenderMask::RequestSenders,
                v5::control::Kind::Completions(_) | v5::control::Kind::Blocked(_) => {
                    v5::SenderMask::CompletionsSenders
                }
                _ => v5::SenderMask::ResultSenders,
            }
        }
    };
    Ok((mask as i32) & (1 << (sender as i32 - 1)) != 0)
}
