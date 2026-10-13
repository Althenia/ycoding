use super::{Driver, Progress};
use crate::{convert, event_subscribe, log};
use prost::{Message, Name};
use std::sync::Arc;
use ycoding_core::event_feed::{Item, Payload, Subscriber};
use ycoding_core::session::log::Entry;
use ycoding_core::ycoding_schema::{DomainDecode, JsonValue, session};
use ycoding_protocol::{
    connection::{Direction, EventMetadata, ProtocolError},
    v5,
};

pub(super) struct Stream {
    request_id: String,
    pub(super) sub_id: String,
    scope: v5::Scope,
    subscriber: Subscriber,
    accepted: bool,
    result_handed: bool,
    held: Option<Arc<Item>>,
}

impl Driver {
    pub(super) fn open_event_stream(&mut self, request_id: String, result: &v5::Result) {
        let Some(scope) = self.pending_events.remove(&request_id) else {
            return;
        };
        let Some(v5::result::Outcome::Success(payload)) = &result.outcome else {
            return;
        };
        let Ok(answer) = v5::EventSubscribeResult::decode(payload.payload.as_slice()) else {
            return;
        };
        let Ok(sub_id) = convert::domain(&answer.subscription_id)
            .map_err(|_| ())
            .and_then(|id| id.to_utf8().map_err(|_| ()))
        else {
            return;
        };
        let (Ok(target), Some(core)) = (
            event_subscribe::target(&scope),
            &self.shared.environment.services.core,
        ) else {
            return;
        };
        let wake = self.wake.clone();
        let Ok(subscriber) = core
            .events
            .subscribe(target, None, move || wake.notify_one())
        else {
            return;
        };
        self.shared.environment.subscriptions.arm(sub_id.clone());
        self.streams.push(Stream {
            request_id,
            sub_id,
            scope,
            subscriber,
            accepted: false,
            result_handed: false,
            held: None,
        });
    }

    pub(super) fn note_stream_handed(&mut self, request_id: &str) {
        for stream in self
            .streams
            .iter_mut()
            .filter(|stream| stream.request_id == request_id)
        {
            stream.result_handed = true;
        }
    }

    pub(super) fn feed_streams(&mut self) {
        let mut position = 0;
        while position < self.streams.len() && self.close.is_none() {
            match self.advance_stream(position) {
                Progress::Blocked | Progress::Live => position += 1,
                Progress::Done => {
                    self.streams.remove(position);
                }
                Progress::Failed(error) => self.fail_with(ycoding_protocol::connection::Close {
                    code: 1002,
                    category: error,
                }),
            }
        }
    }

    pub(super) fn accept_stream(
        &mut self,
        request_id: &str,
        sub_id: &str,
        scope: &v5::Scope,
    ) -> Result<bool, ProtocolError> {
        let now = self.now();
        match self.connection.accept_subscription(
            request_id,
            sub_id.into(),
            scope.clone(),
            now,
            Direction::Send,
        ) {
            Ok(()) => Ok(true),
            Err(ProtocolError::Unknown) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(super) fn end_stream(&mut self, sub_id: &str) -> Progress {
        let body = v5::frame::Body::StreamEnd(v5::StreamEnd {
            subscription_id: sub_id.into(),
        });
        let reserved = self.reserve(v5::LedgerClass::Event, body.clone());
        let now = self.now();
        match self.connection.enqueue(body, reserved, now) {
            Ok(()) => {
                self.shared.environment.subscriptions.remove(sub_id);
                Progress::Done
            }
            Err(ProtocolError::Limit) => Progress::Blocked,
            Err(error) => Progress::Failed(error),
        }
    }

    fn advance_stream(&mut self, position: usize) -> Progress {
        let (request_id, sub_id, scope) = {
            let stream = &self.streams[position];
            (
                stream.request_id.clone(),
                stream.sub_id.clone(),
                stream.scope.clone(),
            )
        };
        if self.shared.environment.subscriptions.ended(&sub_id) {
            return self.end_stream(&sub_id);
        }
        if !self.streams[position].accepted {
            if !self.streams[position].result_handed {
                return Progress::Blocked;
            }
            match self.accept_stream(&request_id, &sub_id, &scope) {
                Ok(true) => self.streams[position].accepted = true,
                Ok(false) => return Progress::Blocked,
                Err(error) => return Progress::Failed(error),
            }
        }
        loop {
            let item = match self.streams[position].held.take() {
                Some(item) => item,
                None => match self.streams[position].subscriber.next() {
                    Ok(Some(item)) => item,
                    Ok(None) => return Progress::Live,
                    Err(_) => return Progress::Failed(ProtocolError::Limit),
                },
            };
            let record = match self.event_record(&item) {
                Ok(Some(record)) => record,
                Ok(None) => continue,
                Err(error) => return Progress::Failed(error),
            };
            match self.enqueue_record(&scope, &sub_id, record) {
                Ok(()) => {}
                Err(ProtocolError::Limit) => {
                    self.streams[position].held = Some(item);
                    return Progress::Blocked;
                }
                Err(error) => return Progress::Failed(error),
            }
        }
    }

    fn event_record(&self, item: &Item) -> Result<Option<v5::EventRecord>, ProtocolError> {
        let event = match &item.payload {
            Payload::Durable(event) => event,
            Payload::Ephemeral(event) => return self.typed_ephemeral_record(event),
        };
        let Some(type_) = event.type_.as_str() else {
            return Err(ProtocolError::Malformed);
        };
        if !type_.starts_with("session.") || log::excluded(type_) {
            return Ok(None);
        }
        let session = session::Id::decode(&JsonValue::String(event.aggregate_id.clone()))
            .map_err(|_| ProtocolError::Malformed)?;
        let entry = Entry::from_event(event)
            .inspect_err(|_| {
                tracing::warn!(position = item.position, "feed event is not decodable")
            })
            .map_err(|_| ProtocolError::Malformed)?;
        let record = log::record(&entry, &session, &self.source_epoch())
            .inspect_err(|error| {
                tracing::debug!(
                    event_type = ?event.type_.as_str(),
                    reason = error.0,
                    "feed event has no v5 wire shape"
                );
            })
            .map_err(|_| ProtocolError::Malformed)?;
        Ok(Some(v5::EventRecord {
            event_id: record.event_id,
            created_ms: record.created_ms,
            durable: Some(v5::DurablePosition {
                aggregate_id: event
                    .aggregate_id
                    .to_utf8()
                    .map_err(|_| ProtocolError::Malformed)?,
                sequence: record.seq,
                version: record.version,
            }),
            event: v5::TypedPayload {
                type_name: v5::SessionLogItem::full_name(),
                payload: record.item.encode_to_vec(),
            },
        }))
    }

    fn typed_ephemeral_record(
        &self,
        _event: &ycoding_core::event_feed::Ephemeral,
    ) -> Result<Option<v5::EventRecord>, ProtocolError> {
        Ok(None)
    }

    fn enqueue_record(
        &mut self,
        scope: &v5::Scope,
        sub_id: &str,
        event: v5::EventRecord,
    ) -> Result<(), ProtocolError> {
        let now = self.now();
        self.connection.enqueue_event(
            event,
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

    pub(super) fn ensure_follow_feed(&mut self) -> bool {
        if self.follow.is_some() {
            return true;
        }
        let Some(core) = &self.shared.environment.services.core else {
            return false;
        };
        let wake = self.wake.clone();
        self.follow = core
            .events
            .subscribe(ycoding_core::event_feed::Scope::Global, None, move || {
                wake.notify_one()
            })
            .ok();
        self.follow.is_some()
    }

    pub(super) fn drain_follow_feed(&mut self) {
        let Some(follow) = &self.follow else {
            return;
        };
        let mut overflowed = false;
        loop {
            match follow.next() {
                Ok(Some(item)) => {
                    if let Payload::Durable(event) = &item.payload {
                        self.subs
                            .iter_mut()
                            .filter(|sub| {
                                sub.follow && sub.session.as_lossless() == &event.aggregate_id
                            })
                            .for_each(|sub| sub.dirty = true);
                    }
                }
                Ok(None) => break,
                Err(_) => {
                    overflowed = true;
                    break;
                }
            }
        }
        if overflowed {
            self.follow = None;
            self.ensure_follow_feed();
            self.subs.iter_mut().for_each(|sub| sub.dirty = true);
        }
        if !self.subs.iter().any(|sub| sub.follow) {
            self.follow = None;
        }
    }
}
