use super::Driver;
use crate::{Dispatcher, Environment, Settled, connector::Error, convert};
use prost::Message;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};
use ycoding_core::event_feed::{Item, Payload, Scope, Subscriber};
use ycoding_protocol::{
    connection::{Direction, EventMetadata, ProtocolError},
    decode_strict, v5,
};

pub(super) struct Interests {
    pub(super) environment: Arc<Environment>,
    identities: BTreeMap<String, String>,
    pub(super) associations: BTreeMap<String, (String, v5::Scope)>,
    ready: BTreeSet<String>,
    observer: Option<Subscriber>,
    held: Option<Arc<Item>>,
}

impl Interests {
    pub(super) fn new(environment: Arc<Environment>) -> Self {
        Self {
            environment,
            identities: BTreeMap::new(),
            associations: BTreeMap::new(),
            ready: BTreeSet::new(),
            observer: None,
            held: None,
        }
    }
}

impl Driver {
    pub(super) async fn snapshot(
        &mut self,
        snapshot: v5::SubscriptionSnapshot,
        dispatcher: &Dispatcher,
    ) -> Result<(), Error> {
        let delta = self
            .machine
            .update_relay_interests(snapshot, self.now())
            .map_err(super::protocol_error)?;
        for session in delta.removed {
            if let Some(id) = self.events.identities.remove(&session) {
                self.events.ready.remove(&id);
                self.events
                    .environment
                    .subscriptions
                    .remove(&self.epoch, &id);
            }
        }
        if self.events.identities.is_empty() {
            self.events.observer = None;
            self.events.held = None;
        }
        for session in delta.added {
            let scope = v5::Scope {
                target: Some(v5::scope::Target::Session(session.clone())),
            };
            let request = v5::Request {
                request_id: format!("interest:{session}"),
                operation_id: dispatcher
                    .operation_id("event.subscribe")
                    .ok_or(Error::Setup)?,
                scope: scope.clone(),
                payload: v5::EventSubscribeRequest {
                    scope: scope.clone(),
                }
                .encode_to_vec(),
            };
            let settled = dispatcher
                .invoke_remote(
                    self.events.environment.clone(),
                    self.epoch.clone(),
                    &self.peer,
                    request,
                )
                .await;
            let Some(Settled::Result(v5::Result {
                outcome: Some(v5::result::Outcome::Success(payload)),
                ..
            })) = settled
            else {
                continue;
            };
            let accepted = decode_strict::<v5::EventSubscribeResult>(&payload.payload)
                .map_err(|_| Error::Incompatible)?;
            let id = convert::domain(&accepted.subscription_id)
                .map_err(|_| Error::Incompatible)?
                .to_utf8()
                .map_err(|_| Error::Incompatible)?;
            if self.events.observer.is_none() {
                self.events.observer = Some(
                    self.events
                        .environment
                        .services
                        .core
                        .as_ref()
                        .ok_or(Error::Setup)?
                        .events
                        .subscribe(Scope::Global, None, || {})
                        .map_err(|_| Error::Transport)?,
                );
            }
            let epoch = self
                .events
                .environment
                .services
                .identity
                .source_epoch
                .clone();
            self.machine
                .register_relay_interest(session.clone(), id.clone(), epoch.clone(), self.now())
                .map_err(super::protocol_error)?;
            self.events
                .environment
                .subscriptions
                .arm(&self.epoch, id.clone());
            self.events.identities.insert(session, id);
            let body = v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::ResyncRequired(v5::ResyncRequired {
                    scope,
                    source_epoch: epoch,
                    message_id: None,
                })),
            });
            self.machine
                .enqueue(
                    body.clone(),
                    self.reserve(v5::LedgerClass::Normal, body),
                    self.now(),
                )
                .map_err(super::protocol_error)?;
        }
        Ok(())
    }

    pub(super) fn subscription_result(
        &mut self,
        settled: Option<Settled>,
        scope: v5::Scope,
    ) -> Result<Option<Settled>, Error> {
        let Some(Settled::Result(mut result)) = settled else {
            return Ok(settled);
        };
        if !ycoding_protocol::OPERATIONS.iter().any(|operation| {
            operation.operation_id == result.operation_id
                && operation.diagnostic_name == "event.subscribe"
        }) {
            return Ok(Some(Settled::Result(result)));
        }
        if let Some(v5::result::Outcome::Success(payload)) = &mut result.outcome {
            let Some(v5::scope::Target::Session(session)) = &scope.target else {
                return Err(Error::Incompatible);
            };
            let id = self
                .events
                .identities
                .get(session)
                .ok_or(Error::Transport)?
                .clone();
            payload.payload = v5::EventSubscribeResult {
                subscription_id: convert::text(&id),
            }
            .encode_to_vec();
            self.events
                .associations
                .insert(result.request_id.clone(), (id, scope));
        }
        Ok(Some(Settled::Result(result)))
    }

    pub(super) fn settle_subscription(&mut self, request_id: &str) -> Result<(), Error> {
        let Some((id, scope)) = self.events.associations.remove(request_id) else {
            return Ok(());
        };
        self.machine
            .accept_subscription(
                request_id,
                id.clone(),
                scope,
                self.now(),
                Direction::Send,
                Some(
                    self.events
                        .environment
                        .services
                        .identity
                        .source_epoch
                        .clone(),
                ),
            )
            .map_err(super::protocol_error)?;
        self.events.ready.insert(id);
        Ok(())
    }

    pub(super) fn feed_events(&mut self) -> Result<(), Error> {
        let Some(observer) = &self.events.observer else {
            return Ok(());
        };
        loop {
            let item = match self.events.held.take() {
                Some(item) => item,
                None => match observer.next().map_err(|_| Error::Transport)? {
                    Some(item) => item,
                    None => return Ok(()),
                },
            };
            let session = match &item.payload {
                Payload::Durable(event) => event
                    .aggregate_id
                    .to_utf8()
                    .map_err(|_| Error::Incompatible)?,
                Payload::Ephemeral(event) => match &event.session {
                    Some(id) => id
                        .as_lossless()
                        .to_utf8()
                        .map_err(|_| Error::Incompatible)?,
                    None => continue,
                },
            };
            let Some(id) = self.events.identities.get(&session) else {
                continue;
            };
            if !self.events.ready.contains(id) {
                self.events.held = Some(item);
                return Ok(());
            }
            let source_epoch = &self.events.environment.services.identity.source_epoch;
            let Some(record) = crate::connection::event_streams::event_record(
                &item,
                &source_epoch.as_str().into(),
                self.events.environment.services.core.as_ref(),
            )
            .map_err(super::protocol_error)?
            else {
                continue;
            };
            match self.machine.enqueue_event(
                record,
                EventMetadata {
                    subscription_id: id.clone(),
                    scope: v5::Scope {
                        target: Some(v5::scope::Target::Session(session)),
                    },
                    source_epoch: source_epoch.clone(),
                    message_id: None,
                    priority: v5::PriorityMode::Interactive,
                },
                self.now(),
            ) {
                Ok(()) => {}
                Err(ProtocolError::Limit) => {
                    self.events.held = Some(item);
                    return Ok(());
                }
                Err(error) => return Err(super::protocol_error(error)),
            }
        }
    }
}
