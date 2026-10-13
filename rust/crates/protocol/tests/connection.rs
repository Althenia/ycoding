use prost::{Message, Name};
use std::collections::BTreeSet;
use ycoding_protocol::connection::{
    Budgets, Config, Connection, Decision, Direction, EventMetadata, Outcome, ProtocolError,
};
use ycoding_protocol::{OPERATIONS, v5};
fn asset_pair(length: usize) -> (Binding, Binding, v5::Result, v5::BulkStart) {
    let (mut client, mut server) = pair();
    let operation = OPERATIONS
        .iter()
        .find(|operation| operation.diagnostic_name == "fs.read")
        .unwrap();
    let request_id = client
        .request(
            operation.operation_id,
            v5::Scope {
                target: Some(v5::scope::Target::Location(
                    ycoding_protocol::encode_lossless(
                        &"/project".encode_utf16().collect::<Vec<_>>(),
                    ),
                )),
            },
            v5::FsReadRequest {
                params: v5::PlatformAssetPath {
                    path: ycoding_protocol::encode_lossless(
                        &"asset.bin".encode_utf16().collect::<Vec<_>>(),
                    ),
                },
                query: Default::default(),
            }
            .encode_to_vec(),
            4,
        )
        .unwrap();
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    let mime = ycoding_protocol::encode_lossless(
        &"application/octet-stream"
            .encode_utf16()
            .collect::<Vec<_>>(),
    );
    let (metadata, _) = ycoding_protocol::Asset::new(
        v5::FsReadResult {
            data: v5::PlatformAssetMetadata {
                mime,
                byte_count: length as u64,
            },
        },
        vec![255; length],
    )
    .unwrap()
    .into_wire()
    .unwrap();
    let result = v5::Result {
        request_id: request_id.clone(),
        operation_id: operation.operation_id,
        settlement: operation.settlement,
        outcome: Some(v5::result::Outcome::AssetMetadata(metadata)),
    };
    let start = v5::BulkStart {
        request_id,
        transfer_id: "asset-1".into(),
        operation_id: operation.operation_id,
        type_name: operation.result_type.clone(),
        content_kind: v5::ContentKind::Asset as i32,
        byte_count: length as u64,
        chunk_count: length.div_ceil(65536) as u32,
    };
    (client, server, result, start)
}

#[test]
fn ac_wire_012_asset_metadata_exact_body_and_empty_asset_settle_once() {
    for length in [0, 1, 65536, 65537] {
        let (mut client, mut server, result, start) = asset_pair(length);
        let Some(v5::result::Outcome::AssetMetadata(metadata)) = result.outcome.clone() else {
            panic!("asset metadata")
        };
        server.respond(result, 5).unwrap();
        let header = send(server.poll(5));
        let decisions = client.receive(header.clone(), header.encoded_len() as u64, 5);
        assert!(matches!(
            decisions.as_slice(),
            [Decision::AssetMetadata { .. }]
        ));
        server
            .queue_frame(v5::frame::Body::BulkStart(start), 6)
            .unwrap();
        let frame = send(server.poll(6));
        client.receive(frame.clone(), frame.encoded_len() as u64, 6);
        for (index, bytes) in vec![255; length].chunks(65536).enumerate() {
            server
                .queue_frame(
                    v5::frame::Body::BulkPiece(v5::BulkPiece {
                        transfer_id: "asset-1".into(),
                        index: index as u32,
                        offset: (index * 65536) as u64,
                        data: bytes.to_vec(),
                    }),
                    7,
                )
                .unwrap();
            let frame = send(server.poll(7));
            assert!(
                !client
                    .receive(frame.clone(), frame.encoded_len() as u64, 7)
                    .iter()
                    .any(|decision| matches!(decision, Decision::Settled { .. }))
            );
        }
        server
            .queue_frame(
                v5::frame::Body::BulkEnd(v5::BulkEnd {
                    transfer_id: "asset-1".into(),
                    byte_count: length as u64,
                    outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
                }),
                8,
            )
            .unwrap();
        let frame = send(server.poll(8));
        let terminal = client.receive(frame.clone(), frame.encoded_len() as u64, 8);
        assert!(
            matches!(terminal.as_slice(), [Decision::Settled { outcome: Outcome::AssetSuccess { metadata: delivered, bytes, .. }, .. }] if delivered.as_ref() == &metadata && bytes.as_slice() == vec![255; length])
        );
        client.release_bulk("asset-1").unwrap();
        assert_eq!(client.stats().reassembly_reserved_bytes, 0);
    }
}
#[test]
fn ac_wire_002_confirm_timeout_after_ready_handoff_is_1008_for_unestablished_producer() {
    let mut client = Binding::new(
        config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let mut server = Binding::new(
        config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let hello = send(client.start(0).unwrap());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
    client.receive(ready.clone(), ready.encoded_len() as u64, 2);
    assert!(
        server
            .poll(5002)
            .iter()
            .any(|decision| matches!(decision, Decision::Closed(close) if close.code == 1008))
    );
}

#[test]
fn ac_wire_009_012_cancel_metadata_only_or_active_asset_is_unknown_and_releases_ownership() {
    for begun in [false, true] {
        let (mut client, mut server, result, start) = asset_pair(65537);
        let id = result.request_id.clone();
        server.respond(result, 5).unwrap();
        let frame = send(server.poll(5));
        client.receive(frame.clone(), frame.encoded_len() as u64, 5);
        if begun {
            server
                .queue_frame(v5::frame::Body::BulkStart(start), 6)
                .unwrap();
            let frame = send(server.poll(6));
            client.receive(frame.clone(), frame.encoded_len() as u64, 6);
        }
        assert!(matches!(
            client.cancel_request(&id, 7).unwrap().as_slice(),
            [Decision::Settled {
                outcome: Outcome::Unknown,
                ..
            }]
        ));
        assert_eq!(client.stats().reassembly_reserved_bytes, 0);
        client.disconnect(true);
        assert_eq!(client.reservation().borrow().used(), 0);
    }
}

#[test]
fn ac_wire_011_relay_union_owns_shared_backend_identity_until_last_client_release() {
    let mut agent = Binding::new(
        config(v5::PeerRole::Agent, v5::PeerRole::Relay),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let mut relay = Binding::new(
        config(v5::PeerRole::Relay, v5::PeerRole::Agent),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let hello = send(agent.start(0).unwrap());
    let ready = send(relay.receive(hello.clone(), hello.encoded_len() as u64, 1));
    let ping = send(agent.receive(ready.clone(), ready.encoded_len() as u64, 2));
    relay.receive(ping.clone(), ping.encoded_len() as u64, 3);
    let pong = send(relay.poll(3));
    agent.receive(pong.clone(), pong.encoded_len() as u64, 3);
    assert_eq!(
        agent
            .update_relay_interests(
                v5::SubscriptionSnapshot {
                    client_id: "one".into(),
                    session_ids: vec!["ses_a".into()]
                },
                4
            )
            .unwrap()
            .added,
        ["ses_a"]
    );
    assert_eq!(
        agent
            .update_relay_interests(
                v5::SubscriptionSnapshot {
                    client_id: "two".into(),
                    session_ids: vec!["ses_a".into()]
                },
                4
            )
            .unwrap()
            .added
            .len(),
        0
    );
    agent
        .register_relay_interest(
            "ses_a".into(),
            "accepted-a".into(),
            "backend-source".into(),
            4,
        )
        .unwrap();
    assert_eq!(agent.relay_subscription_id("ses_a"), Some("accepted-a"));
    assert!(
        agent
            .release_relay_client("one", 5)
            .unwrap()
            .removed
            .is_empty()
    );
    assert_eq!(agent.relay_subscription_id("ses_a"), Some("accepted-a"));
    assert_eq!(
        agent.release_relay_client("two", 5).unwrap().removed,
        ["ses_a"]
    );
    assert_eq!(agent.relay_subscription_id("ses_a"), None);
    assert_eq!(agent.relay_interest_retained_bytes(), 0);
}
#[test]
fn ac_wire_011_forwarded_batch_preserves_identity_and_releases_only_on_credit_or_teardown() {
    for handed in [false, true] {
        let mut remote_config = config(v5::PeerRole::RemoteClient, v5::PeerRole::Relay);
        remote_config.authorized_sessions.insert("session".into());
        let mut relay_config = config(v5::PeerRole::Relay, v5::PeerRole::RemoteClient);
        relay_config.authorized_sessions.insert("session".into());
        let mut client = Binding::new(remote_config, OPERATIONS.clone(), 0).unwrap();
        let mut relay = Binding::new(relay_config, OPERATIONS.clone(), 0).unwrap();
        let hello = send(client.start(0).unwrap());
        let ready = send(relay.receive(hello.clone(), hello.encoded_len() as u64, 1));
        let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
        relay.receive(ping.clone(), ping.encoded_len() as u64, 3);
        let pong = send(relay.poll(3));
        client.receive(pong.clone(), pong.encoded_len() as u64, 3);
        let scope = batch("one").scope;
        let id = client
            .request(
                4000,
                scope.clone(),
                v5::EventSubscribeRequest {
                    scope: scope.clone(),
                    ..Default::default()
                }
                .encode_to_vec(),
                4,
            )
            .unwrap();
        let frame = send(client.poll(4));
        relay.receive(frame.clone(), frame.encoded_len() as u64, 4);
        relay
            .respond(
                v5::Result {
                    request_id: id.clone(),
                    operation_id: 4000,
                    settlement: v5::Settlement::Completed as i32,
                    outcome: Some(v5::result::Outcome::Success(v5::TypedPayload {
                        type_name: v5::EventSubscribeResult::full_name(),
                        payload: v5::EventSubscribeResult {
                            subscription_id: ycoding_protocol::encode_lossless(
                                &"sub".encode_utf16().collect::<Vec<_>>(),
                            ),
                        }
                        .encode_to_vec(),
                    })),
                },
                5,
            )
            .unwrap();
        let frame = send(relay.poll(5));
        client.receive(frame.clone(), frame.encoded_len() as u64, 5);
        relay
            .machine
            .accept_subscription(&id, "sub".into(), scope.clone(), 6, Direction::Send)
            .unwrap();
        client
            .machine
            .accept_subscription(&id, "sub".into(), scope, 6, Direction::Receive)
            .unwrap();
        client.begin_hydration("sub").unwrap();
        client
            .complete_hydration("sub", "source".into(), 6)
            .unwrap();
        let batch = batch("forwarded");
        let mut wrong = batch.clone();
        wrong.scope.target = Some(v5::scope::Target::Session("another-session".into()));
        assert_eq!(
            relay.forward_event_batch(wrong, 6),
            Err(ProtocolError::Direction)
        );
        let mut unknown = batch.clone();
        unknown.subscription_id = "unaccepted".into();
        assert_eq!(
            relay.forward_event_batch(unknown, 6),
            Err(ProtocolError::Malformed)
        );
        let ticket = relay.forward_event_batch(batch.clone(), 6).unwrap();
        if !handed {
            assert!(
                relay
                    .disconnect(true)
                    .contains(&Decision::EventBatchReleased {
                        ticket,
                        consumed: false
                    })
            );
            assert_eq!(relay.reservation().borrow().used(), 0);
            continue;
        }
        let frame = send(relay.poll(6));
        assert!(
            matches!(&frame.body, Some(v5::frame::Body::EventBatch(delivered)) if delivered == &batch)
        );
        client.receive(frame.clone(), frame.encoded_len() as u64, 6);
        assert!(relay.stats().handed_bytes[1] > 0);
        client
            .consume(v5::LedgerClass::Event, frame.delivery_ordinal.unwrap(), 6)
            .unwrap();
        let receipt = send(client.poll(31));
        relay.receive(receipt.clone(), receipt.encoded_len() as u64, 31);
        assert!(
            relay
                .take_decisions()
                .contains(&Decision::EventBatchReleased {
                    ticket,
                    consumed: true
                })
        );
        assert_eq!(relay.stats().handed_bytes[1], 0);
    }
}

struct Binding {
    machine: Connection,
    role: v5::PeerRole,
    epoch: String,
    now: u64,
    next_request: u64,
    scopes: std::collections::BTreeMap<String, v5::Scope>,
}

impl std::ops::Deref for Binding {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        &self.machine
    }
}
impl std::ops::DerefMut for Binding {
    fn deref_mut(&mut self) -> &mut Connection {
        &mut self.machine
    }
}

impl Binding {
    fn new(
        config: Config,
        mut descriptors: Vec<v5::OperationDescriptor>,
        now: u64,
    ) -> Result<Self, ProtocolError> {
        for descriptor in &mut descriptors {
            if config.event_types == test_only_public_event_types()
                && !descriptor.event_types.is_empty()
            {
                descriptor.event_types = test_only_public_event_types().into_iter().collect();
            }
        }
        Ok(Self {
            role: config.local_role,
            epoch: config.connection_epoch.clone(),
            machine: Connection::new(config, descriptors, now)?,
            now,
            next_request: 1,
            scopes: Default::default(),
        })
    }
    fn reserve(&self, body: v5::frame::Body) -> u64 {
        v5::Frame {
            revision: 5,
            connection_epoch: Some(self.epoch.clone()),
            ledger: Some(match body {
                v5::frame::Body::EventBatch(_) | v5::frame::Body::StreamEnd(_) => {
                    v5::LedgerClass::Event
                }
                v5::frame::Body::BulkPiece(_) => v5::LedgerClass::Bulk,
                _ => v5::LedgerClass::Normal,
            } as i32),
            delivery_ordinal: Some(u64::MAX),
            tiny_consumed_through: Some(u64::MAX),
            body: Some(body),
        }
        .encoded_len() as u64
    }
    fn poll(&mut self, now: u64) -> Vec<Decision> {
        self.now = now;
        let mut decisions = self.machine.advance(now);
        if let Some(prepared) = self.machine.prepare_handoff(now) {
            let bytes = prepared.frame().encode_to_vec();
            decisions.extend(
                self.machine
                    .handoff(prepared, bytes.len() as u64, now)
                    .unwrap(),
            );
        }
        decisions.extend(self.machine.take_decisions());
        decisions
    }
    fn start(&mut self, now: u64) -> Result<Vec<Decision>, ProtocolError> {
        let mut decisions = self.machine.start(now)?;
        decisions.extend(self.poll(now));
        Ok(decisions)
    }
    fn receive(&mut self, frame: v5::Frame, byte_length: u64, now: u64) -> Vec<Decision> {
        self.now = now;
        let handshake = matches!(
            frame.body,
            Some(v5::frame::Body::Hello(_) | v5::frame::Body::Ready(_))
        );
        let Some(token) = self.machine.admit_incoming(byte_length) else {
            return self.machine.take_decisions();
        };
        let decoded = ycoding_protocol::decode_strict::<v5::Frame>(&frame.encode_to_vec());
        let mut decisions = match decoded {
            Ok(frame) => self.machine.accept_incoming(&token, frame, now).unwrap(),
            Err(_) => self.machine.reject_incoming(&token).unwrap(),
        };
        if handshake {
            decisions.extend(self.poll(now));
        }
        decisions
    }
    fn request(
        &mut self,
        operation_id: u32,
        scope: v5::Scope,
        payload: Vec<u8>,
        now: u64,
    ) -> Result<String, ProtocolError> {
        self.now = now;
        let reserve = self.reserve(v5::frame::Body::Request(v5::Request {
            request_id: self.next_request.to_string(),
            operation_id,
            scope: scope.clone(),
            payload: payload.clone(),
        }));
        let id =
            self.machine
                .request(operation_id, scope.clone(), payload.clone(), reserve, now)?;
        let accepted_scope = if operation_id == 4000 {
            ycoding_protocol::decode_strict::<v5::EventSubscribeRequest>(&payload)
                .unwrap()
                .scope
        } else {
            scope
        };
        self.next_request += 1;
        self.scopes.insert(id.clone(), accepted_scope);
        Ok(id)
    }
    fn respond(&mut self, result: v5::Result, now: u64) -> Result<(), ProtocolError> {
        self.now = now;
        self.machine.respond(
            result.clone(),
            self.reserve(v5::frame::Body::Result(result)),
            now,
        )
    }
    fn queue_frame(&mut self, body: v5::frame::Body, now: u64) -> Result<(), ProtocolError> {
        self.now = now;
        let reserve = self.reserve(body.clone());
        self.machine.enqueue(body, reserve, now)
    }
    fn queue_events(
        &mut self,
        batch: v5::EventBatch,
        priority: v5::PriorityMode,
        now: u64,
    ) -> Result<(), ProtocolError> {
        self.now = now;
        for event in batch.events {
            self.machine.enqueue_event(
                event,
                EventMetadata {
                    subscription_id: batch.subscription_id.clone(),
                    scope: batch.scope.clone(),
                    source_epoch: batch.source_epoch.clone(),
                    message_id: None,
                    priority,
                },
                now,
            )?;
        }
        Ok(())
    }
    fn accept_subscription(
        &mut self,
        request_id: &str,
        subscription_id: String,
        source: String,
    ) -> Result<(), ProtocolError> {
        let scope = self
            .scopes
            .get(request_id)
            .cloned()
            .ok_or(ProtocolError::Unknown)?;
        self.machine.accept_subscription(
            request_id,
            subscription_id.clone(),
            scope,
            self.now,
            Direction::Receive,
        )?;
        self.machine.begin_hydration(&subscription_id)?;
        self.machine
            .complete_hydration(&subscription_id, source, self.now)?;
        Ok(())
    }
    fn end_hydration(
        &mut self,
        subscription_id: &str,
        canonical_source_epoch: String,
    ) -> Result<Vec<Decision>, ProtocolError> {
        self.machine
            .complete_hydration(subscription_id, canonical_source_epoch, self.now)
    }
}

fn config(local: v5::PeerRole, peer: v5::PeerRole) -> Config {
    Config {
        local_role: local,
        peer_role: peer,
        source_epoch: "source".into(),
        connection_epoch: "epoch".into(),
        budgets: Budgets::default(),
        authorized_sessions: BTreeSet::new(),
        authorized_workspaces: BTreeSet::new(),
        reservation: None,
        event_types: test_only_public_event_types(),
    }
}

fn test_only_public_event_types() -> BTreeSet<String> {
    BTreeSet::from([
        v5::HealthGetRequest::full_name(),
        v5::LosslessString::full_name(),
    ])
}

fn send(decisions: Vec<Decision>) -> v5::Frame {
    decisions
        .into_iter()
        .find_map(|decision| {
            if let Decision::Send(frame) = decision {
                Some(frame)
            } else {
                None
            }
        })
        .expect("frame")
}

#[test]
fn ac_wire_002_ready_confirmation_and_epoch_fence() {
    let mut client = Binding::new(
        config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let mut server = Binding::new(
        config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let hello = send(client.start(0).unwrap());
    assert!(hello.connection_epoch.is_none());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
    assert_eq!(ready.connection_epoch.as_deref(), Some("epoch"));
    let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
    assert_eq!(ping.connection_epoch.as_deref(), Some("epoch"));
    assert!(
        server
            .receive(ping.clone(), ping.encoded_len() as u64, 3)
            .contains(&Decision::Established)
    );
    let mut wrong = ping;
    wrong.connection_epoch = Some("stale".into());
    assert!(
        server
            .receive(wrong.clone(), wrong.encoded_len() as u64, 4)
            .iter()
            .any(
                |d| matches!(d, Decision::Closed(close) if close.category == ProtocolError::Epoch)
            )
    );
}

#[test]
fn ac_wire_002_handshake_timeout_has_no_dispatch() {
    let mut server = Binding::new(
        config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    assert!(
        server
            .poll(5000)
            .iter()
            .any(|d| matches!(d, Decision::Closed(close) if close.code == 1008))
    );
}

fn pair() -> (Binding, Binding) {
    pair_with(Budgets::default())
}

fn pair_with(budgets: Budgets) -> (Binding, Binding) {
    let mut client = Binding::new(
        config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let mut server_config = config(v5::PeerRole::Server, v5::PeerRole::LocalClient);
    server_config.budgets = budgets;
    let mut server = Binding::new(server_config, OPERATIONS.clone(), 0).unwrap();
    let hello = send(client.start(0).unwrap());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
    let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
    server.receive(ping.clone(), ping.encoded_len() as u64, 3);
    let pong = send(server.poll(3));
    client.receive(pong.clone(), pong.encoded_len() as u64, 3);
    (client, server)
}

fn stop(client: &mut Binding, time: u64) -> String {
    client
        .request(
            3009,
            v5::Scope {
                target: Some(v5::scope::Target::Session("session".into())),
            },
            v5::BrowserStopRequest {
                params: v5::BrowserStopRequestParams {
                    session_id: ycoding_protocol::encode_lossless(
                        &"session".encode_utf16().collect::<Vec<_>>(),
                    ),
                },
            }
            .encode_to_vec(),
            time,
        )
        .unwrap()
}

fn result(id: &str) -> v5::Result {
    v5::Result {
        request_id: id.into(),
        operation_id: 3009,
        settlement: v5::Settlement::Completed as i32,
        outcome: Some(v5::result::Outcome::Success(v5::TypedPayload {
            type_name: "ycoding.v5.browser_stop_Result".into(),
            payload: v5::BrowserStopResult { data: v5::Empty {} }.encode_to_vec(),
        })),
    }
}

#[test]
fn ac_wire_009_sent_and_unsent_cancel_do_not_replay() {
    let (mut client, _) = pair();
    let unsent = stop(&mut client, 4);
    assert_eq!(
        client.cancel_request(&unsent, 4).unwrap(),
        vec![Decision::Settled {
            request_id: unsent,
            outcome: Outcome::Unsent
        }]
    );
    assert!(client.poll(4).is_empty());
    let sent = stop(&mut client, 5);
    assert_eq!(sent, "2");
    assert!(matches!(
        send(client.poll(5)).body,
        Some(v5::frame::Body::Request(_))
    ));
    assert!(
        client
            .cancel_request(&sent, 6)
            .unwrap()
            .contains(&Decision::Settled {
                request_id: sent,
                outcome: Outcome::Unknown
            })
    );
    assert!(matches!(
        send(client.poll(6)).body,
        Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Cancel(_))
        }))
    ));
}

#[test]
fn ac_wire_009_result_settlement_and_late_drop() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    assert!(matches!(
        server
            .receive(request.clone(), request.encoded_len() as u64, 4)
            .as_slice(),
        [Decision::Request(_)]
    ));
    server.respond(result(&id), 5).unwrap();
    let response = send(server.poll(5));
    assert!(matches!(
        client
            .receive(response.clone(), response.encoded_len() as u64, 5)
            .as_slice(),
        [Decision::Settled {
            outcome: Outcome::Success {
                settlement: v5::Settlement::Completed,
                ..
            },
            ..
        }]
    ));
    let mut late = response;
    late.delivery_ordinal = Some(2);
    assert!(
        client
            .receive(late.clone(), late.encoded_len() as u64, 6)
            .is_empty()
    );
    assert!(
        client
            .disconnect(true)
            .iter()
            .all(|d| !matches!(d, Decision::Settled { .. }))
    );
}

#[test]
fn ac_wire_012_bulk_settles_only_at_exact_successful_end() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    let data = v5::BrowserStopResult { data: v5::Empty {} }.encode_to_vec();
    let start = v5::BulkStart {
        request_id: id.clone(),
        transfer_id: "transfer".into(),
        operation_id: 3009,
        type_name: "ycoding.v5.browser_stop_Result".into(),
        content_kind: v5::ContentKind::TypedMessage as i32,
        byte_count: data.len() as u64,
        chunk_count: 1,
    };
    for (time, body) in [
        (5, v5::frame::Body::BulkStart(start)),
        (
            6,
            v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 0,
                offset: 0,
                data: data.clone(),
            }),
        ),
    ] {
        server.queue_frame(body, time).unwrap();
        let frame = send(server.poll(time));
        assert!(
            client
                .receive(frame.clone(), frame.encoded_len() as u64, time)
                .iter()
                .all(|d| !matches!(d, Decision::Settled { .. }))
        );
    }
    server
        .queue_frame(
            v5::frame::Body::BulkEnd(v5::BulkEnd {
                transfer_id: "transfer".into(),
                byte_count: data.len() as u64,
                outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
            }),
            7,
        )
        .unwrap();
    let frame = send(server.poll(7));
    assert!(
        matches!(client.receive(frame.clone(), frame.encoded_len() as u64, 7).as_slice(), [Decision::Settled { request_id, outcome: Outcome::BulkSuccess { settlement: v5::Settlement::Completed, bytes, .. } }] if request_id == &id && bytes.as_ref() == &data)
    );
}

fn generated_events_descriptor() -> v5::OperationDescriptor {
    OPERATIONS
        .iter()
        .find(|operation| operation.diagnostic_name == "event.subscribe")
        .unwrap()
        .clone()
}

fn global_scope() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}

fn subscription_result(request_id: String, subscription_id: &str) -> v5::Result {
    v5::Result {
        request_id,
        operation_id: 4000,
        settlement: v5::Settlement::Completed as i32,
        outcome: Some(v5::result::Outcome::Success(v5::TypedPayload {
            type_name: "ycoding.v5.event_subscribe_Result".into(),
            payload: v5::EventSubscribeResult {
                subscription_id: ycoding_protocol::encode_lossless(
                    &subscription_id.encode_utf16().collect::<Vec<_>>(),
                ),
            }
            .encode_to_vec(),
        })),
    }
}

fn subscribe_target(
    client: &mut Binding,
    server: &mut Binding,
    scope: v5::Scope,
    subscription_id: &str,
    now: u64,
) {
    let id = client
        .request(
            4000,
            if client.role == v5::PeerRole::LocalClient {
                global_scope()
            } else {
                scope.clone()
            },
            v5::EventSubscribeRequest {
                scope: scope.clone(),
            }
            .encode_to_vec(),
            now,
        )
        .unwrap();
    let request = send(client.poll(now));
    server.receive(request.clone(), request.encoded_len() as u64, now);
    server
        .respond(subscription_result(id.clone(), subscription_id), now)
        .unwrap();
    let response = send(server.poll(now));
    let decoded_id = match response.body.as_ref().unwrap() {
        v5::frame::Body::Result(v5::Result {
            outcome: Some(v5::result::Outcome::Success(payload)),
            ..
        }) => String::from_utf16(
            &ycoding_protocol::decode_lossless(
                &ycoding_protocol::decode_strict::<v5::EventSubscribeResult>(&payload.payload)
                    .unwrap()
                    .subscription_id,
                1024,
            )
            .unwrap(),
        )
        .unwrap(),
        _ => panic!("subscription result"),
    };
    client.receive(response.clone(), response.encoded_len() as u64, now);
    client
        .accept_subscription(&id, decoded_id.clone(), "source".into())
        .unwrap();
    server
        .machine
        .accept_subscription(&id, decoded_id, scope, now, Direction::Send)
        .unwrap();
}

#[test]
fn ac_wire_011_subscription_identity_and_bounded_hydration() {
    let descriptors = vec![generated_events_descriptor()];
    let mut client = Binding::new(
        config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
        descriptors.clone(),
        0,
    )
    .unwrap();
    let mut server = Binding::new(
        config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
        descriptors,
        0,
    )
    .unwrap();
    let hello = send(client.start(0).unwrap());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
    let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
    server.receive(ping.clone(), ping.encoded_len() as u64, 3);
    let scope = v5::Scope {
        target: Some(v5::scope::Target::Session("session".into())),
    };
    let id = client
        .request(
            4000,
            global_scope(),
            v5::EventSubscribeRequest {
                scope: scope.clone(),
            }
            .encode_to_vec(),
            4,
        )
        .unwrap();
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    server
        .respond(subscription_result(id.clone(), "sub"), 5)
        .unwrap();
    let pong = send(server.poll(5));
    client.receive(pong.clone(), pong.encoded_len() as u64, 5);
    let response = send(server.poll(5));
    client.receive(response.clone(), response.encoded_len() as u64, 5);
    client
        .accept_subscription(&id, "sub".into(), "source".into())
        .unwrap();
    server
        .machine
        .accept_subscription(&id, "sub".into(), scope.clone(), 5, Direction::Send)
        .unwrap();
    client.begin_hydration("sub").unwrap();
    let batch = v5::EventBatch {
        subscription_id: "sub".into(),
        scope,
        source_epoch: "source".into(),
        events: vec![v5::EventRecord {
            event_id: "event".into(),
            created_ms: 0,
            durable: None,
            event: v5::TypedPayload {
                type_name: v5::HealthGetRequest::full_name(),
                payload: v5::HealthGetRequest {}.encode_to_vec(),
            },
        }],
    };
    server
        .queue_events(batch.clone(), v5::PriorityMode::Interactive, 6)
        .unwrap();
    let frame = send(server.poll(46));
    assert!(
        client
            .receive(frame.clone(), frame.encoded_len() as u64, 6)
            .is_empty()
    );
    assert_eq!(
        client.end_hydration("sub", "source".into()).unwrap(),
        vec![Decision::Events(batch)]
    );
    server
        .queue_frame(
            v5::frame::Body::StreamEnd(v5::StreamEnd {
                subscription_id: "sub".into(),
            }),
            47,
        )
        .unwrap();
    let end = send(server.poll(47));
    assert_eq!(
        client.receive(end.clone(), end.encoded_len() as u64, 47),
        vec![Decision::StreamComplete("sub".into())]
    );
}

fn established_frame(body: v5::frame::Body, class: v5::LedgerClass, ordinal: u64) -> v5::Frame {
    v5::Frame {
        revision: 5,
        connection_epoch: Some("epoch".into()),
        ledger: Some(class as i32),
        delivery_ordinal: Some(ordinal),
        tiny_consumed_through: None,
        body: Some(body),
    }
}

#[test]
fn ac_wire_008_unsolicited_pong_does_not_generate_ack_and_repeated_ping_is_not_amplified() {
    let (mut client, mut server) = pair();
    let pong = established_frame(
        v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Pong(v5::Pong { id: 999 })),
        }),
        v5::LedgerClass::Tiny,
        2,
    );
    assert!(
        client
            .receive(pong.clone(), pong.encoded_len() as u64, 4)
            .is_empty()
    );
    assert!(client.poll(4).is_empty());
    let repeated_ping = established_frame(
        v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Ping(v5::Ping { id: 1 })),
        }),
        v5::LedgerClass::Tiny,
        2,
    );
    server.receive(repeated_ping.clone(), repeated_ping.encoded_len() as u64, 4);
    assert!(server.poll(4).is_empty());
}

#[test]
fn ac_wire_008_responder_idle_heartbeat_confirms_receipts_without_ack_loop() {
    let (_, mut server) = pair();
    let frame = send(server.poll(20003));
    assert!(matches!(
        frame.body,
        Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Ping(_))
        }))
    ));
    assert_eq!(frame.tiny_consumed_through, Some(1));
    assert!(server.poll(20004).is_empty());
}

#[test]
fn ac_wire_012_queued_bulk_end_never_overtakes_its_pieces() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    let data = v5::BrowserStopResult { data: v5::Empty {} }.encode_to_vec();
    for body in [
        v5::frame::Body::BulkStart(v5::BulkStart {
            request_id: id,
            transfer_id: "transfer".into(),
            operation_id: 3009,
            type_name: "ycoding.v5.browser_stop_Result".into(),
            content_kind: v5::ContentKind::TypedMessage as i32,
            byte_count: data.len() as u64,
            chunk_count: 1,
        }),
        v5::frame::Body::BulkPiece(v5::BulkPiece {
            transfer_id: "transfer".into(),
            index: 0,
            offset: 0,
            data: data.clone(),
        }),
        v5::frame::Body::BulkEnd(v5::BulkEnd {
            transfer_id: "transfer".into(),
            byte_count: data.len() as u64,
            outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
        }),
    ] {
        server.queue_frame(body, 5).unwrap();
    }
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::BulkStart(_))
    ));
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::BulkPiece(_))
    ));
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::BulkEnd(_))
    ));
}

#[test]
fn ac_wire_008_session_rotation_and_two_events_to_one_bulk() {
    let (mut client, mut server) = pair();
    for session in ["a", "b"] {
        subscribe_target(
            &mut client,
            &mut server,
            v5::Scope {
                target: Some(v5::scope::Target::Session(session.into())),
            },
            session,
            3,
        );
    }
    for session in ["a", "a", "b"] {
        for index in 0..64 {
            push_individual_event(
                &mut server,
                batch(&format!("{session}-{index}")).events.remove(0),
                event_metadata(session, session, "source", v5::PriorityMode::Interactive),
                4,
            )
            .unwrap();
        }
    }
    let session = |frame: v5::Frame| match frame.body.unwrap() {
        v5::frame::Body::EventBatch(batch) => batch.subscription_id,
        _ => panic!("event"),
    };
    assert_eq!(session(send(server.poll(4))), "a");
    assert_eq!(session(send(server.poll(4))), "b");
    assert_eq!(session(send(server.poll(4))), "a");
}

#[test]
fn ac_wire_009_invalid_typed_bulk_content_remains_unknown_not_silently_settled() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    let start = established_frame(
        v5::frame::Body::BulkStart(v5::BulkStart {
            request_id: id.clone(),
            transfer_id: "bad".into(),
            operation_id: 3009,
            type_name: "ycoding.v5.browser_stop_Result".into(),
            content_kind: v5::ContentKind::TypedMessage as i32,
            byte_count: 1,
            chunk_count: 1,
        }),
        v5::LedgerClass::Normal,
        1,
    );
    client.receive(start.clone(), start.encoded_len() as u64, 5);
    let piece = established_frame(
        v5::frame::Body::BulkPiece(v5::BulkPiece {
            transfer_id: "bad".into(),
            index: 0,
            offset: 0,
            data: vec![0],
        }),
        v5::LedgerClass::Bulk,
        1,
    );
    client.receive(piece.clone(), piece.encoded_len() as u64, 6);
    let end = established_frame(
        v5::frame::Body::BulkEnd(v5::BulkEnd {
            transfer_id: "bad".into(),
            byte_count: 1,
            outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
        }),
        v5::LedgerClass::Normal,
        2,
    );
    assert!(
        client
            .receive(end.clone(), end.encoded_len() as u64, 7)
            .contains(&Decision::Settled {
                request_id: id,
                outcome: Outcome::Unknown
            })
    );
}

#[test]
fn ac_wire_008_exact_delivery_counters_clear_only_on_credit_or_teardown() {
    let (mut client, mut server) = pair();
    stop(&mut client, 4);
    assert!(client.stats().queued_bytes[0] > 0);
    let frame = send(client.poll(4));
    assert_eq!(client.stats().queued_bytes[0], 0);
    assert_eq!(client.stats().handed_bytes[0], frame.encoded_len() as u64);
    server.receive(frame.clone(), frame.encoded_len() as u64, 4);
    assert_eq!(server.stats().received_bytes[0], frame.encoded_len() as u64);
    server.consume(v5::LedgerClass::Normal, 1, 4).unwrap();
    assert!(server.poll(28).is_empty());
    let credit = send(server.poll(29));
    assert_eq!(server.stats().received_bytes[0], 0);
    client.receive(credit.clone(), credit.encoded_len() as u64, 29);
    assert_eq!(client.stats().handed_bytes[0], 0);
    client.disconnect(false);
    assert_eq!(client.stats(), Default::default());
}

#[test]
fn ac_wire_006_revocation_fences_all_pending_work() {
    let (mut client, _) = pair();
    let id = stop(&mut client, 4);
    send(client.poll(4));
    let decisions = client.revoke(4403).unwrap();
    assert!(decisions.contains(&Decision::Settled {
        request_id: id,
        outcome: Outcome::Unknown
    }));
    assert!(matches!(decisions.last(), Some(Decision::Closed(close)) if close.code == 4403));
    assert!(client.poll(5).is_empty());
}

#[test]
fn ac_wire_008_consumption_without_sent_credit_does_not_grant_peer_capacity() {
    let window = 131072;
    let (mut client, mut server) = pair_with(Budgets {
        normal_window_bytes: window,
        ..Budgets::default()
    });
    stop(&mut client, 4);
    let first = send(client.poll(4));
    assert!(matches!(
        server.receive(first.clone(), window, 4).as_slice(),
        [Decision::Request(_)]
    ));
    server.consume(v5::LedgerClass::Normal, 1, 4).unwrap();
    let mut second = first;
    second.delivery_ordinal = Some(2);
    if let Some(v5::frame::Body::Request(request)) = &mut second.body {
        request.request_id = "other".into();
    }
    assert!(
        server
            .receive(second.clone(), second.encoded_len() as u64, 5)
            .iter()
            .any(
                |d| matches!(d, Decision::Closed(close) if close.category == ProtocolError::Limit)
            )
    );
}

#[test]
fn ac_wire_009_unallocated_results_fail_instead_of_disappearing() {
    for id in ["0", "1", "future", "18446744073709551616"] {
        let (mut client, _) = pair();
        let frame = established_frame(
            v5::frame::Body::Result(result(id)),
            v5::LedgerClass::Normal,
            1,
        );
        assert!(
            client
                .receive(frame.clone(), frame.encoded_len() as u64, 4)
                .iter()
                .any(|d| matches!(d, Decision::Closed(_))),
            "{id}"
        );
    }
}

#[test]
fn ac_wire_008_ledger_timeout_is_class_local_and_other_connection_progresses() {
    let (mut stalled, _) = pair();
    stop(&mut stalled, 4);
    send(stalled.poll(4));
    assert!(
        stalled
            .poll(30004)
            .iter()
            .any(|d| matches!(d, Decision::Closed(_)))
    );
    let (mut healthy, mut server) = pair();
    stop(&mut healthy, 4);
    let frame = send(healthy.poll(4));
    assert!(matches!(
        server
            .receive(frame.clone(), frame.encoded_len() as u64, 4)
            .as_slice(),
        [Decision::Request(_)]
    ));
}

fn batch(id: &str) -> v5::EventBatch {
    v5::EventBatch {
        subscription_id: "sub".into(),
        scope: v5::Scope {
            target: Some(v5::scope::Target::Session("session".into())),
        },
        source_epoch: "source".into(),
        events: vec![v5::EventRecord {
            event_id: id.into(),
            created_ms: 0,
            durable: None,
            event: v5::TypedPayload {
                type_name: v5::HealthGetRequest::full_name(),
                payload: v5::HealthGetRequest {}.encode_to_vec(),
            },
        }],
    }
}

fn subscribed_pair(budgets: Budgets) -> (Binding, Binding) {
    let descriptors = OPERATIONS.clone();
    let mut client_config = config(v5::PeerRole::LocalClient, v5::PeerRole::Server);
    client_config.budgets = budgets;
    let mut client = Binding::new(client_config, descriptors.clone(), 0).unwrap();
    let mut server = Binding::new(
        config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
        descriptors,
        0,
    )
    .unwrap();
    let hello = send(client.start(0).unwrap());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
    let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
    server.receive(ping.clone(), ping.encoded_len() as u64, 3);
    let pong = send(server.poll(3));
    client.receive(pong.clone(), pong.encoded_len() as u64, 3);
    let id = client
        .request(
            4000,
            global_scope(),
            v5::EventSubscribeRequest {
                scope: batch("a").scope,
            }
            .encode_to_vec(),
            3,
        )
        .unwrap();
    let request = send(client.poll(3));
    server.receive(request.clone(), request.encoded_len() as u64, 3);
    server
        .respond(subscription_result(id.clone(), "sub"), 3)
        .unwrap();
    let response = send(server.poll(3));
    client.receive(response.clone(), response.encoded_len() as u64, 3);
    client
        .accept_subscription(&id, "sub".into(), "source".into())
        .unwrap();
    server
        .machine
        .accept_subscription(&id, "sub".into(), batch("a").scope, 3, Direction::Send)
        .unwrap();
    (client, server)
}

#[test]
fn ac_wire_011_hydration_overflow_requires_canonical_reload_before_live_delivery() {
    let (mut client, _) = subscribed_pair(Budgets {
        event_queue_count: 1,
        ..Budgets::default()
    });
    client.begin_hydration("sub").unwrap();
    for (index, expected_resync) in [(1, false), (2, true), (3, true)] {
        let frame = established_frame(
            v5::frame::Body::EventBatch(batch(&index.to_string())),
            v5::LedgerClass::Event,
            index,
        );
        let decisions = client.receive(frame.clone(), frame.encoded_len() as u64, 6);
        assert_eq!(
            decisions.iter().any(|d| matches!(d, Decision::Resync(_))),
            expected_resync
        );
        assert!(decisions.iter().all(|d| !matches!(d, Decision::Events(_))));
    }
    client.begin_hydration("sub").unwrap();
    let frame = established_frame(
        v5::frame::Body::EventBatch(batch("reload")),
        v5::LedgerClass::Event,
        4,
    );
    client.receive(frame.clone(), frame.encoded_len() as u64, 7);
    assert_eq!(
        client.end_hydration("sub", "source".into()).unwrap(),
        vec![Decision::Events(batch("reload"))]
    );
}

#[test]
fn ac_wire_008_event_coalescing_has_caller_timed_interactive_and_background_bounds() {
    for (priority, delay) in [
        (v5::PriorityMode::Interactive, 40),
        (v5::PriorityMode::Background, 750),
    ] {
        let (_, mut server) = subscribed_pair(Budgets::default());
        server.queue_events(batch("first"), priority, 4).unwrap();
        server.queue_events(batch("second"), priority, 5).unwrap();
        assert!(server.poll(4 + delay - 1).is_empty());
        let frame = send(server.poll(4 + delay));
        assert!(
            matches!(frame.body, Some(v5::frame::Body::EventBatch(batch)) if batch.events.iter().map(|event| event.event_id.as_str()).collect::<Vec<_>>() == ["first", "second"])
        );
    }
}

#[test]
fn ac_wire_002_handshake_invalid_input_matrix_dispatches_nothing() {
    for case in 0..8 {
        let mut client = Binding::new(
            config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
            OPERATIONS.clone(),
            0,
        )
        .unwrap();
        let mut server = Binding::new(
            config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
            OPERATIONS.clone(),
            0,
        )
        .unwrap();
        let mut hello = send(client.start(0).unwrap());
        match case {
            0 => hello.connection_epoch = Some("fabricated".into()),
            1 => hello.delivery_ordinal = Some(1),
            2 => hello.revision = 4,
            3 => {
                hello.body = Some(v5::frame::Body::Request(v5::Request {
                    request_id: "1".into(),
                    operation_id: 3009,
                    scope: batch("a").scope,
                    payload: vec![],
                }))
            }
            4 => {
                if let Some(v5::frame::Body::Hello(value)) = &mut hello.body {
                    value.role = v5::PeerRole::RemoteClient as i32;
                }
            }
            5 => {
                if let Some(v5::frame::Body::Hello(value)) = &mut hello.body {
                    value.contract_digest = vec![0; 32];
                }
            }
            6 => {
                if let Some(v5::frame::Body::Hello(value)) = &mut hello.body {
                    value.receive_windows.normal_bytes += 1;
                }
            }
            _ => hello.tiny_consumed_through = Some(0),
        }
        let decisions = server.receive(hello.clone(), hello.encoded_len() as u64, 1);
        assert!(
            matches!(decisions.as_slice(), [Decision::Closed(close)] if close.code == 1008),
            "case {case}: {decisions:?}"
        );
        if let Some(Decision::Closed(close)) = decisions.last() {
            assert!(close.reason().is_ascii() && close.reason().len() <= 96);
        }
    }
}

#[test]
fn ac_wire_009_settlement_operation_and_body_mismatch_are_terminal_failures() {
    for case in 0..3 {
        let (mut client, _) = pair();
        let id = stop(&mut client, 4);
        send(client.poll(4));
        let mut result = result(&id);
        match case {
            0 => result.operation_id += 1,
            1 => result.settlement = v5::Settlement::DurablyAdmitted as i32,
            _ => {
                if let Some(v5::result::Outcome::Success(payload)) = &mut result.outcome {
                    payload.type_name = "ycoding.v5.Empty".into();
                }
            }
        }
        let frame = established_frame(v5::frame::Body::Result(result), v5::LedgerClass::Normal, 1);
        let decisions = client.receive(frame.clone(), frame.encoded_len() as u64, 5);
        assert!(decisions.contains(&Decision::Settled {
            request_id: id,
            outcome: Outcome::Unknown
        }));
        assert!(matches!(decisions.last(), Some(Decision::Closed(_))));
    }
}

fn role_pair(
    initiator: v5::PeerRole,
    responder: v5::PeerRole,
    descriptors: Vec<v5::OperationDescriptor>,
) -> (Binding, Binding) {
    role_pair_with(initiator, responder, descriptors, Budgets::default())
}

fn role_pair_with(
    initiator: v5::PeerRole,
    responder: v5::PeerRole,
    descriptors: Vec<v5::OperationDescriptor>,
    budgets: Budgets,
) -> (Binding, Binding) {
    let mut client = Binding::new(config(initiator, responder), descriptors.clone(), 0).unwrap();
    let mut server_config = config(responder, initiator);
    server_config.budgets = budgets;
    let mut server = Binding::new(server_config, descriptors, 0).unwrap();
    let hello = send(client.start(0).unwrap());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
    let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
    server.receive(ping.clone(), ping.encoded_len() as u64, 3);
    let pong = send(server.poll(3));
    client.receive(pong.clone(), pong.encoded_len() as u64, 3);
    (client, server)
}

fn generated_relay_operation() -> v5::OperationDescriptor {
    OPERATIONS
        .iter()
        .find(|descriptor| descriptor.diagnostic_name == "workspace.list")
        .unwrap()
        .clone()
}

#[test]
fn canonical_remote_scopes_allow_session_events_and_deny_global_or_location_feeds() {
    for target in [
        v5::scope::Target::Session("session".into()),
        v5::scope::Target::Global(v5::Empty {}),
        v5::scope::Target::Location(ycoding_protocol::encode_lossless(
            &"/arbitrary".encode_utf16().collect::<Vec<_>>(),
        )),
    ] {
        let (mut client, _) = role_pair(
            v5::PeerRole::RemoteClient,
            v5::PeerRole::Relay,
            OPERATIONS.clone(),
        );
        client.replace_authority(BTreeSet::from(["session".into()]), BTreeSet::new());
        let allowed = matches!(target, v5::scope::Target::Session(_));
        let scope = v5::Scope {
            target: Some(target),
        };
        let payload = v5::EventSubscribeRequest {
            scope: scope.clone(),
        }
        .encode_to_vec();
        assert_eq!(client.request(4000, scope, payload, 4).is_ok(), allowed);
    }
}

#[test]
fn public_subscription_accepts_ephemerals_but_not_log_sync_payloads() {
    for is_public in [true, false] {
        let mut client_config = config(v5::PeerRole::LocalClient, v5::PeerRole::Server);
        client_config.event_types = BTreeSet::from([
            v5::PublicEvent::full_name(),
            v5::SessionLogItem::full_name(),
        ]);
        let mut server_config = config(v5::PeerRole::Server, v5::PeerRole::LocalClient);
        server_config.event_types = client_config.event_types.clone();
        let mut client = Binding::new(client_config, OPERATIONS.clone(), 0).unwrap();
        let mut server = Binding::new(server_config, OPERATIONS.clone(), 0).unwrap();
        let hello = send(client.start(0).unwrap());
        let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 1));
        let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 2));
        server.receive(ping.clone(), ping.encoded_len() as u64, 3);
        let pong = send(server.poll(3));
        client.receive(pong.clone(), pong.encoded_len() as u64, 3);
        subscribe_target(&mut client, &mut server, batch("sub").scope, "sub", 4);
        let payload = if is_public {
            v5::PublicEvent {
                kind: Some(v5::public_event::Kind::CatalogUpdated(
                    v5::PublicEventCatalogUpdated {
                        id: ycoding_protocol::encode_lossless(
                            &"evt_catalog".encode_utf16().collect::<Vec<_>>(),
                        ),
                        r#type: 1,
                        ..Default::default()
                    },
                )),
            }
            .encode_to_vec()
        } else {
            v5::SessionLogItem {
                kind: Some(v5::session_log_item::Kind::Value52(
                    v5::SessionLogItemValue52 {
                        r#type: 1,
                        aggregate_id: ycoding_protocol::encode_lossless(
                            &"session".encode_utf16().collect::<Vec<_>>(),
                        ),
                        source_epoch: ycoding_protocol::encode_lossless(
                            &"source".encode_utf16().collect::<Vec<_>>(),
                        ),
                        ..Default::default()
                    },
                )),
            }
            .encode_to_vec()
        };
        let mut event_batch = batch("evt_catalog");
        event_batch.events[0].event = v5::TypedPayload {
            type_name: if is_public {
                v5::PublicEvent::full_name()
            } else {
                v5::SessionLogItem::full_name()
            },
            payload,
        };
        let frame = established_frame(
            v5::frame::Body::EventBatch(event_batch),
            v5::LedgerClass::Event,
            1,
        );
        let decisions = client.receive(frame.clone(), frame.encoded_len() as u64, 5);
        assert_eq!(
            decisions
                .iter()
                .any(|decision| matches!(decision, Decision::Events(_))),
            is_public
        );
        assert_eq!(
            decisions
                .iter()
                .any(|decision| matches!(decision, Decision::Closed(_))),
            !is_public
        );
    }
}

fn workspace_list(binding: &mut Binding, now: u64) -> String {
    binding
        .request(
            5006,
            v5::Scope {
                target: Some(v5::scope::Target::Machine(v5::Empty {})),
            },
            v5::WorkspaceListRequest {
                payload: v5::WorkspaceListRequestPayload {
                    sessions_only: None,
                },
            }
            .encode_to_vec(),
            now,
        )
        .unwrap()
}

#[test]
fn ac_wire_006_generated_local_only_table_denies_remote_and_relay_roles() {
    let (mut browser, _) = role_pair(
        v5::PeerRole::RemoteClient,
        v5::PeerRole::Relay,
        OPERATIONS.clone(),
    );
    let (_, mut relay) = role_pair(v5::PeerRole::Agent, v5::PeerRole::Relay, OPERATIONS.clone());
    for descriptor in OPERATIONS
        .iter()
        .filter(|descriptor| descriptor.roles == [v5::PeerRole::LocalClient as i32])
    {
        assert_eq!(
            browser.request(descriptor.operation_id, batch("a").scope, vec![], 4),
            Err(ProtocolError::Direction)
        );
        assert_eq!(
            relay.request(descriptor.operation_id, batch("a").scope, vec![], 4),
            Err(ProtocolError::Direction)
        );
    }
    assert!(browser.poll(4).is_empty());
    assert!(relay.poll(4).is_empty());
}

#[test]
fn ac_wire_007_relay_forwards_typed_bulk_without_reassembly() {
    let (mut agent, mut relay) = role_pair(
        v5::PeerRole::Agent,
        v5::PeerRole::Relay,
        vec![generated_relay_operation()],
    );
    let id = workspace_list(&mut relay, 4);
    let request = send(relay.poll(4));
    assert!(matches!(
        agent
            .receive(request.clone(), request.encoded_len() as u64, 4)
            .as_slice(),
        [Decision::Request(_)]
    ));
    for body in [
        v5::frame::Body::BulkStart(v5::BulkStart {
            request_id: id,
            transfer_id: "transfer".into(),
            operation_id: 5006,
            type_name: "ycoding.v5.workspace_list_Result".into(),
            content_kind: v5::ContentKind::TypedMessage as i32,
            byte_count: 2,
            chunk_count: 1,
        }),
        v5::frame::Body::BulkPiece(v5::BulkPiece {
            transfer_id: "transfer".into(),
            index: 0,
            offset: 0,
            data: vec![10, 0],
        }),
        v5::frame::Body::BulkEnd(v5::BulkEnd {
            transfer_id: "transfer".into(),
            byte_count: 2,
            outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
        }),
    ] {
        agent.queue_frame(body, 5).unwrap();
        let frame = send(agent.poll(5));
        assert_eq!(
            relay.receive(frame.clone(), frame.encoded_len() as u64, 5),
            vec![Decision::Forward(frame)]
        );
        assert_eq!(relay.stats().reassembly_received_bytes, 0);
        assert_eq!(relay.stats().reassembly_reserved_bytes, 0);
    }
}

#[test]
fn ac_wire_007_relay_recipient_budget_survives_handoff_and_rejects_overrun() {
    assert_eq!(Budgets::default().relay_peer_bytes, 1048576);
    let (mut browser, mut relay) = role_pair_with(
        v5::PeerRole::RemoteClient,
        v5::PeerRole::Relay,
        OPERATIONS.clone(),
        Budgets {
            relay_peer_bytes: 65536,
            ..Budgets::default()
        },
    );
    let id = workspace_list(&mut browser, 4);
    let request = send(browser.poll(4));
    relay.receive(request.clone(), request.encoded_len() as u64, 4);
    relay
        .queue_frame(
            v5::frame::Body::BulkStart(v5::BulkStart {
                request_id: id,
                transfer_id: "transfer".into(),
                operation_id: 5006,
                type_name: "ycoding.v5.workspace_list_Result".into(),
                content_kind: v5::ContentKind::TypedMessage as i32,
                byte_count: 100000,
                chunk_count: 2,
            }),
            4,
        )
        .unwrap();
    send(relay.poll(4));
    relay
        .queue_frame(
            v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 0,
                offset: 0,
                data: vec![0; 50000],
            }),
            4,
        )
        .unwrap();
    send(relay.poll(4));
    assert!(relay.stats().handed_bytes[2] <= 65536);
    assert!(relay.stats().handed_bytes[2] > 50000);
    let before = relay.stats();
    assert_eq!(
        relay.queue_frame(
            v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 1,
                offset: 50000,
                data: vec![0; 50000]
            }),
            5
        ),
        Err(ProtocolError::Limit)
    );
    assert_eq!(relay.stats(), before);
    assert!(
        relay
            .disconnect(false)
            .iter()
            .any(|d| matches!(d, Decision::Closed(_)))
    );
}

#[test]
fn ac_wire_010_cancel_transfer_releases_assembly_and_never_claims_partial_success() {
    let (mut client, _) = pair();
    let id = stop(&mut client, 4);
    send(client.poll(4));
    let start = established_frame(
        v5::frame::Body::BulkStart(v5::BulkStart {
            request_id: id.clone(),
            transfer_id: "transfer".into(),
            operation_id: 3009,
            type_name: "ycoding.v5.browser_stop_Result".into(),
            content_kind: v5::ContentKind::TypedMessage as i32,
            byte_count: 2,
            chunk_count: 1,
        }),
        v5::LedgerClass::Normal,
        1,
    );
    client.receive(start.clone(), start.encoded_len() as u64, 5);
    assert_eq!(client.stats().reassembly_reserved_bytes, 2);
    assert!(
        client
            .cancel_transfer("transfer", 6)
            .unwrap()
            .contains(&Decision::Settled {
                request_id: id,
                outcome: Outcome::Unknown
            })
    );
    assert_eq!(client.stats().reassembly_reserved_bytes, 0);
    assert!(
        matches!(send(client.poll(6)).body, Some(v5::frame::Body::Control(v5::Control { kind: Some(v5::control::Kind::Cancel(v5::Cancel { target: Some(v5::cancel::Target::TransferId(id)) })) })) if id == "transfer")
    );
}

#[test]
fn ac_wire_008_tiny_rate_count_byte_and_ordinal_violations_close() {
    for (budgets, count) in [
        (
            Budgets {
                tiny_rate: 2,
                ..Budgets::default()
            },
            3,
        ),
        (
            Budgets {
                tiny_rate_bytes: 60,
                ..Budgets::default()
            },
            3,
        ),
        (
            Budgets {
                tiny_queue_count: 2,
                ..Budgets::default()
            },
            3,
        ),
    ] {
        let (_, mut client) = pair_with(budgets);
        let mut closed = false;
        for ordinal in 2..=count + 1 {
            let frame = established_frame(
                v5::frame::Body::Control(v5::Control {
                    kind: Some(v5::control::Kind::Pong(v5::Pong { id: 100 + ordinal })),
                }),
                v5::LedgerClass::Tiny,
                ordinal,
            );
            closed |= client
                .receive(frame.clone(), frame.encoded_len() as u64, 4)
                .iter()
                .any(|d| matches!(d, Decision::Closed(_)));
        }
        assert!(closed);
    }
}

#[test]
fn ac_wire_008_credit_and_tiny_receipt_forgery_matrix() {
    for (receipt, credit) in [(Some(2), None), (None, Some(1)), (None, Some(0))] {
        let (mut client, _) = pair();
        let mut frame = established_frame(
            v5::frame::Body::Control(v5::Control {
                kind: Some(match credit {
                    Some(through) => v5::control::Kind::Credit(v5::Credit {
                        ledger: v5::LedgerClass::Normal as i32,
                        consumed_through: through,
                    }),
                    None => v5::control::Kind::Pong(v5::Pong { id: 999 }),
                }),
            }),
            v5::LedgerClass::Tiny,
            2,
        );
        frame.tiny_consumed_through = receipt;
        assert!(
            client
                .receive(frame.clone(), frame.encoded_len() as u64, 4)
                .iter()
                .any(|d| matches!(d, Decision::Closed(_)))
        );
    }
}

#[test]
fn ac_wire_010_disconnect_emits_request_scoped_abort_without_session_interruption() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    assert!(server.disconnect(false).contains(&Decision::CancelWork {
        target: v5::cancel::Target::RequestId(id),
        mutation: true
    }));
}

#[test]
fn ac_wire_006_incoming_id_reuse_is_concurrent_only() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    server.respond(result(&id), 5).unwrap();
    send(server.poll(5));
    let mut reused = request;
    reused.delivery_ordinal = Some(2);
    assert!(matches!(
        server
            .receive(reused.clone(), reused.encoded_len() as u64, 6)
            .as_slice(),
        [Decision::Request(_)]
    ));
    reused.delivery_ordinal = Some(3);
    assert!(
        server
            .receive(reused.clone(), reused.encoded_len() as u64, 7)
            .iter()
            .all(|d| !matches!(d, Decision::Request(_)))
    );
}

#[test]
fn ac_wire_012_bulk_boundary_error_and_incomplete_cases() {
    for case in 0..5 {
        let (mut client, _) = pair();
        let id = stop(&mut client, 4);
        send(client.poll(4));
        let start = established_frame(
            v5::frame::Body::BulkStart(v5::BulkStart {
                request_id: id.clone(),
                transfer_id: "transfer".into(),
                operation_id: 3009,
                type_name: "ycoding.v5.browser_stop_Result".into(),
                content_kind: v5::ContentKind::TypedMessage as i32,
                byte_count: 2,
                chunk_count: 1,
            }),
            v5::LedgerClass::Normal,
            1,
        );
        client.receive(start.clone(), start.encoded_len() as u64, 5);
        let body = match case {
            0 => v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 1,
                offset: 0,
                data: vec![10, 0],
            }),
            1 => v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 0,
                offset: 1,
                data: vec![10, 0],
            }),
            2 => v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 0,
                offset: 0,
                data: vec![10, 0, 0],
            }),
            3 => v5::frame::Body::BulkEnd(v5::BulkEnd {
                transfer_id: "transfer".into(),
                byte_count: 0,
                outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
            }),
            _ => v5::frame::Body::BulkEnd(v5::BulkEnd {
                transfer_id: "transfer".into(),
                byte_count: 0,
                outcome: Some(v5::bulk_end::Outcome::Error(v5::TypedPayload {
                    type_name: "ycoding.v5.InvalidRequestError".into(),
                    payload: v5::InvalidRequestError {
                        tag: 1,
                        message: ycoding_protocol::encode_lossless(&[]),
                        kind: None,
                        field: None,
                    }
                    .encode_to_vec(),
                })),
            }),
        };
        let class = if case < 3 {
            v5::LedgerClass::Bulk
        } else {
            v5::LedgerClass::Normal
        };
        let frame = established_frame(body, class, if case < 3 { 1 } else { 2 });
        let decisions = client.receive(frame.clone(), frame.encoded_len() as u64, 6);
        if case < 4 {
            assert!(decisions.contains(&Decision::Settled {
                request_id: id,
                outcome: Outcome::Unknown
            }));
            assert!(matches!(decisions.last(), Some(Decision::Closed(_))));
        } else {
            assert!(matches!(
                decisions.as_slice(),
                [Decision::Settled {
                    outcome: Outcome::Rejected(_),
                    ..
                }]
            ));
        }
        assert_eq!(client.stats().reassembly_reserved_bytes, 0);
    }
}

#[test]
fn ac_wire_007_pending_cap_is_bounded_without_dropping_existing_work() {
    let (mut client, _) = pair();
    for index in 1..=32 {
        assert_eq!(stop(&mut client, 4), index.to_string());
    }
    assert_eq!(
        client.request(
            3009,
            batch("a").scope,
            v5::BrowserStopRequest {
                params: v5::BrowserStopRequestParams {
                    session_id: ycoding_protocol::encode_lossless(&[97])
                }
            }
            .encode_to_vec(),
            4
        ),
        Err(ProtocolError::Limit)
    );
    assert_eq!(client.stats().pending_requests, 32);
    let decisions = client.disconnect(true);
    assert_eq!(
        decisions
            .iter()
            .filter(|d| matches!(
                d,
                Decision::Settled {
                    outcome: Outcome::Unsent,
                    ..
                }
            ))
            .count(),
        32
    );
    assert!(matches!(decisions.last(), Some(Decision::Closed(close)) if close.code == 1012));
}

#[test]
fn ac_wire_008_negotiated_window_reserves_headers_before_exact_handoff_charge() {
    let mut expected = established_frame(
        v5::frame::Body::Request(v5::Request {
            request_id: "1".into(),
            operation_id: 3009,
            scope: batch("a").scope,
            payload: v5::BrowserStopRequest {
                params: v5::BrowserStopRequestParams {
                    session_id: ycoding_protocol::encode_lossless(
                        &"session".encode_utf16().collect::<Vec<_>>(),
                    ),
                },
            }
            .encode_to_vec(),
        }),
        v5::LedgerClass::Normal,
        1,
    );
    expected.tiny_consumed_through = Some(1);
    let bytes = expected.encoded_len() as u64;
    let mut reserved = expected.clone();
    reserved.delivery_ordinal = Some(u64::MAX);
    reserved.tiny_consumed_through = Some(u64::MAX);
    let reservation = reserved.encoded_len() as u64;
    for window in [reservation - 1, reservation, reservation + 1] {
        let (mut client, _) = pair_with(Budgets {
            normal_window_bytes: window,
            ..Budgets::default()
        });
        let request = match expected.body.as_ref().unwrap() {
            v5::frame::Body::Request(request) => request,
            _ => panic!("request"),
        };
        let id = client.request(3009, request.scope.clone(), request.payload.clone(), 4);
        if window < reservation {
            assert_eq!(id, Err(ProtocolError::Limit));
            continue;
        }
        assert_eq!(id, Ok("1".into()));
        let frame = send(client.poll(4));
        assert_eq!(frame, expected);
        assert_eq!(client.stats().handed_bytes[0], bytes);
    }
}

#[test]
fn ac_wire_008_two_event_batches_to_one_bulk_piece_when_both_wait() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    server
        .queue_frame(
            v5::frame::Body::BulkStart(v5::BulkStart {
                request_id: id,
                transfer_id: "transfer".into(),
                operation_id: 3009,
                type_name: "ycoding.v5.browser_stop_Result".into(),
                content_kind: v5::ContentKind::TypedMessage as i32,
                byte_count: 2,
                chunk_count: 1,
            }),
            5,
        )
        .unwrap();
    server
        .queue_frame(
            v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 0,
                offset: 0,
                data: vec![10, 0],
            }),
            5,
        )
        .unwrap();
    for id in ["a", "b", "c"] {
        for index in 0..64 {
            push_individual_event(
                &mut server,
                batch(&format!("{id}-{index}")).events.remove(0),
                event_metadata("sub", "session", "source", v5::PriorityMode::Interactive),
                5,
            )
            .unwrap();
        }
    }
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::BulkStart(_))
    ));
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::EventBatch(_))
    ));
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::EventBatch(_))
    ));
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::BulkPiece(_))
    ));
    assert!(matches!(
        send(server.poll(5)).body,
        Some(v5::frame::Body::EventBatch(_))
    ));
}

#[test]
fn ac_wire_008_all_non_tiny_controls_are_normal_and_require_consumption() {
    for control in [
        v5::control::Kind::InventoryInvalidated(v5::InventoryInvalidated {}),
        v5::control::Kind::Blocked(v5::Blocked {
            session_id: "session".into(),
            title: None,
        }),
        v5::control::Kind::Completions(v5::Completions {
            items: vec![],
            more: false,
        }),
        v5::control::Kind::Status(v5::Status {
            running: vec![],
            attention: vec![],
            outstanding: None,
            failed: None,
            details: None,
        }),
        v5::control::Kind::ResyncRequired(v5::ResyncRequired {
            scope: batch("a").scope,
            source_epoch: "source".into(),
            message_id: None,
        }),
    ] {
        let (_, mut server) = pair();
        server
            .queue_frame(
                v5::frame::Body::Control(v5::Control {
                    kind: Some(control),
                }),
                4,
            )
            .unwrap();
        let frame = send(server.poll(4));
        assert_eq!(frame.ledger, Some(v5::LedgerClass::Normal as i32));
        assert_eq!(server.stats().handed_bytes[0], frame.encoded_len() as u64);
        assert!(
            server
                .poll(30004)
                .iter()
                .any(|d| matches!(d, Decision::Closed(_)))
        );
    }
}

#[test]
fn ac_wire_007_relay_routes_typed_result_as_opaque_bytes_without_domain_decode() {
    let (_, mut relay) = role_pair(
        v5::PeerRole::Agent,
        v5::PeerRole::Relay,
        vec![generated_relay_operation()],
    );
    let id = workspace_list(&mut relay, 4);
    send(relay.poll(4));
    let mut response = result(&id);
    response.operation_id = 5006;
    if let Some(v5::result::Outcome::Success(payload)) = &mut response.outcome {
        payload.type_name = "ycoding.v5.workspace_list_Result".into();
        payload.payload = vec![0];
    }
    let frame = established_frame(
        v5::frame::Body::Result(response),
        v5::LedgerClass::Normal,
        1,
    );
    assert_eq!(
        relay.receive(frame.clone(), frame.encoded_len() as u64, 5),
        vec![Decision::Forward(frame)]
    );
    assert_eq!(relay.stats().pending_requests, 0);
    assert!(ycoding_protocol::decode_strict::<v5::WorkspaceListResult>(&[0]).is_err());
}

#[test]
fn ac_wire_003_duplicate_operation_descriptor_ids_are_rejected_at_construction() {
    let descriptor = generated_events_descriptor();
    assert!(matches!(
        Binding::new(
            config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
            vec![descriptor.clone(), descriptor],
            0
        ),
        Err(ProtocolError::Malformed)
    ));
}

#[test]
fn ac_wire_008_hydration_receipt_cannot_credit_an_earlier_unapplied_live_batch() {
    let (mut client, _) = subscribed_pair(Budgets::default());
    let live = established_frame(
        v5::frame::Body::EventBatch(batch("live")),
        v5::LedgerClass::Event,
        1,
    );
    assert_eq!(
        client.receive(live.clone(), live.encoded_len() as u64, 6),
        vec![Decision::Events(batch("live"))]
    );
    client.begin_hydration("sub").unwrap();
    let buffered = established_frame(
        v5::frame::Body::EventBatch(batch("buffered")),
        v5::LedgerClass::Event,
        2,
    );
    assert!(
        client
            .receive(buffered.clone(), buffered.encoded_len() as u64, 7)
            .is_empty()
    );
    assert!(client.poll(32).is_empty());
    assert_eq!(
        client.consume(v5::LedgerClass::Event, 1, 33),
        Ok((live.encoded_len() + buffered.encoded_len()) as u64)
    );
    let credit = send(client.poll(58));
    assert!(matches!(
        credit.body,
        Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Credit(v5::Credit {
                consumed_through: 2,
                ..
            }))
        }))
    ));
}

#[test]
fn ac_wire_007_inline_preflight_rejects_size_before_scanning_malformed_body() {
    let (mut client, _) = pair();
    assert_eq!(
        client.request(3009, batch("a").scope, vec![0; 65537], 4),
        Err(ProtocolError::Limit)
    );
    assert_eq!(client.stats().pending_requests, 0);
    assert!(client.poll(4).is_empty());
    assert_eq!(stop(&mut client, 5), "1");
}

#[test]
fn ac_wire_009_request_and_unadmitted_cancel_arrival_order_is_preserved() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    let mut decisions = server.receive(request.clone(), request.encoded_len() as u64, 4);
    client.cancel_request(&id, 5).unwrap();
    let cancel = send(client.poll(5));
    decisions.extend(server.receive(cancel.clone(), cancel.encoded_len() as u64, 5));
    let second = stop(&mut client, 6);
    let next = send(client.poll(6));
    decisions.extend(server.receive(next.clone(), next.encoded_len() as u64, 6));
    assert!(
        matches!(decisions.as_slice(), [Decision::Request(first), Decision::CancelWork { target: v5::cancel::Target::RequestId(cancelled), mutation: true }, Decision::Request(next)] if first.request_id == id && cancelled == &id && next.request_id == second)
    );
}

#[test]
fn ac_wire_011_stream_cannot_complete_while_resync_is_unresolved() {
    let (mut client, _) = subscribed_pair(Budgets {
        event_queue_count: 1,
        ..Budgets::default()
    });
    client.begin_hydration("sub").unwrap();
    for (index, id) in ["first", "overflow"].into_iter().enumerate() {
        let frame = established_frame(
            v5::frame::Body::EventBatch(batch(id)),
            v5::LedgerClass::Event,
            index as u64 + 1,
        );
        client.receive(frame.clone(), frame.encoded_len() as u64, 6);
    }
    let end = established_frame(
        v5::frame::Body::StreamEnd(v5::StreamEnd {
            subscription_id: "sub".into(),
        }),
        v5::LedgerClass::Event,
        3,
    );
    let decisions = client.receive(end.clone(), end.encoded_len() as u64, 7);
    assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
    assert!(
        decisions
            .iter()
            .all(|decision| !matches!(decision, Decision::StreamComplete(_)))
    );
    assert!(
        client
            .disconnect(false)
            .iter()
            .all(|d| !matches!(d, Decision::StreamComplete(_)))
    );
}

#[test]
fn ac_wire_002_ready_deadline_starts_when_hello_is_sent() {
    let mut client = Binding::new(
        config(v5::PeerRole::LocalClient, v5::PeerRole::Server),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let mut server = Binding::new(
        config(v5::PeerRole::Server, v5::PeerRole::LocalClient),
        OPERATIONS.clone(),
        0,
    )
    .unwrap();
    let hello = send(client.start(4000).unwrap());
    let ready = send(server.receive(hello.clone(), hello.encoded_len() as u64, 4000));
    let ping = send(client.receive(ready.clone(), ready.encoded_len() as u64, 8000));
    assert!(
        server
            .receive(ping.clone(), ping.encoded_len() as u64, 8500)
            .contains(&Decision::Established)
    );
}

#[test]
fn ac_wire_002_missing_established_epoch_maps_to_epoch_failure() {
    let (mut client, _) = pair();
    let mut frame = established_frame(
        v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Pong(v5::Pong { id: 99 })),
        }),
        v5::LedgerClass::Tiny,
        2,
    );
    frame.connection_epoch = None;
    assert!(
        client
            .receive(frame.clone(), frame.encoded_len() as u64, 4)
            .iter()
            .any(
                |d| matches!(d, Decision::Closed(close) if close.category == ProtocolError::Epoch)
            )
    );
}

fn log_subscription(client: &mut Binding, server: &mut Binding) -> String {
    let scope = batch("log").scope;
    let id = client
        .request(
            4039,
            scope.clone(),
            v5::SessionLogRequest {
                params: v5::SessionLogRequestParams {
                    session_id: ycoding_protocol::encode_lossless(
                        &"session".encode_utf16().collect::<Vec<_>>(),
                    ),
                },
                query: v5::SessionLogRequestQuery {
                    after: None,
                    follow: Some(false),
                },
            }
            .encode_to_vec(),
            4,
        )
        .unwrap();
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    server
        .respond(
            v5::Result {
                request_id: id.clone(),
                operation_id: 4039,
                settlement: v5::Settlement::Completed as i32,
                outcome: Some(v5::result::Outcome::Success(v5::TypedPayload {
                    type_name: "ycoding.v5.session_log_Result".into(),
                    payload: v5::SessionLogResult {
                        subscription_id: ycoding_protocol::encode_lossless(
                            &"log".encode_utf16().collect::<Vec<_>>(),
                        ),
                    }
                    .encode_to_vec(),
                })),
            },
            4,
        )
        .unwrap();
    let response = send(server.poll(4));
    client.receive(response.clone(), response.encoded_len() as u64, 4);
    id
}

fn stream_end(id: &str) -> v5::frame::Body {
    v5::frame::Body::StreamEnd(v5::StreamEnd {
        subscription_id: id.into(),
    })
}

#[test]
fn parity_session_events_target_mismatch_is_a_malformed_close() {
    for target in [
        v5::scope::Target::Session("other".into()),
        v5::scope::Target::Machine(v5::Empty {}),
        v5::scope::Target::Workspace("workspace".into()),
    ] {
        let (mut client, mut server) = pair();
        let id = log_subscription(&mut client, &mut server);
        assert_eq!(
            client.machine.accept_subscription(
                &id,
                "log".into(),
                v5::Scope {
                    target: Some(target)
                },
                4,
                Direction::Receive
            ),
            Err(ProtocolError::Malformed)
        );
        assert!(client.machine.take_decisions().iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
    }
}

#[test]
fn parity_stream_end_flushes_events_uses_event_ledger_and_completes_once() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    server
        .queue_events(batch("before"), v5::PriorityMode::Background, 4)
        .unwrap();
    server.queue_frame(stream_end("sub"), 5).unwrap();
    let event = send(server.poll(5));
    assert!(matches!(event.body, Some(v5::frame::Body::EventBatch(_))));
    client.receive(event.clone(), event.encoded_len() as u64, 5);
    let end = send(server.poll(5));
    assert_eq!(end.ledger, Some(v5::LedgerClass::Event as i32));
    assert_eq!(
        client.receive(end.clone(), end.encoded_len() as u64, 5),
        vec![Decision::StreamComplete("sub".into())]
    );
    let repeated = established_frame(stream_end("sub"), v5::LedgerClass::Event, 3);
    assert!(client.receive(repeated.clone(), repeated.encoded_len() as u64, 6).iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
}

#[test]
fn parity_stream_end_waits_for_queued_and_handed_scoped_resync() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    server
        .queue_frame(
            v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::ResyncRequired(v5::ResyncRequired {
                    scope: batch("a").scope,
                    source_epoch: "canonical".into(),
                    message_id: None,
                })),
            }),
            4,
        )
        .unwrap();
    server.queue_frame(stream_end("sub"), 4).unwrap();
    let resync = send(server.poll(4));
    assert!(matches!(resync.body, Some(v5::frame::Body::Control(_))));
    assert!(server.poll(4).is_empty());
    assert!(
        client
            .receive(resync.clone(), resync.encoded_len() as u64, 4)
            .iter()
            .any(|decision| matches!(decision, Decision::Resync(_)))
    );
    client
        .machine
        .consume(v5::LedgerClass::Normal, 1, 4)
        .unwrap();
    let credit = send(client.poll(29));
    server.receive(credit.clone(), credit.encoded_len() as u64, 29);
    let end = send(server.poll(29));
    client.begin_hydration("sub").unwrap();
    assert!(
        client
            .machine
            .complete_hydration("sub", "canonical".into(), 29)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        client.receive(end.clone(), end.encoded_len() as u64, 29),
        vec![Decision::StreamComplete("sub".into())]
    );
}

#[test]
fn parity_hydration_and_resync_block_finite_success_until_canonical_reconciliation() {
    for hydrating in [true, false] {
        let (mut client, mut server) = subscribed_pair(Budgets::default());
        if hydrating {
            client.begin_hydration("sub").unwrap();
        }
        if !hydrating {
            let resync = established_frame(
                v5::frame::Body::Control(v5::Control {
                    kind: Some(v5::control::Kind::ResyncRequired(v5::ResyncRequired {
                        scope: batch("a").scope,
                        source_epoch: "changed".into(),
                        message_id: None,
                    })),
                }),
                v5::LedgerClass::Normal,
                2,
            );
            client.receive(resync.clone(), resync.encoded_len() as u64, 4);
        }
        server.queue_frame(stream_end("sub"), 4).unwrap();
        let end = send(server.poll(4));
        let decisions = client.receive(end.clone(), end.encoded_len() as u64, 4);
        assert!(
            decisions
                .iter()
                .all(|decision| !matches!(decision, Decision::StreamComplete(_)))
        );
        assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
    }
}

#[test]
fn parity_release_producer_drops_queued_events_and_prepared_end_without_success() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    server
        .queue_events(batch("before"), v5::PriorityMode::Background, 4)
        .unwrap();
    server.queue_frame(stream_end("sub"), 4).unwrap();
    assert!(
        server
            .machine
            .release_subscription("sub", Direction::Send)
            .unwrap()
    );
    assert_eq!(server.stats().queued_bytes[1], 0);
    assert!(server.poll(4).is_empty());
    assert!(
        client
            .disconnect(false)
            .iter()
            .all(|decision| !matches!(decision, Decision::StreamComplete(_)))
    );
    let (_, mut server) = subscribed_pair(Budgets::default());
    server.queue_frame(stream_end("sub"), 4).unwrap();
    let prepared = server.machine.prepare_handoff(4).unwrap();
    assert!(
        server
            .machine
            .release_subscription("sub", Direction::Send)
            .unwrap()
    );
    assert_eq!(server.stats().prepared_bytes, 0);
    assert_eq!(server.stats().queued_bytes[1], 0);
    assert_eq!(
        server.machine.handoff(prepared, 50, 4),
        Err(ProtocolError::Unknown)
    );
}

#[test]
fn parity_receiver_stream_end_rejects_unresolved_source() {
    let (mut client, _) = subscribed_pair(Budgets::default());
    let mut changed = batch("changed-source");
    changed.source_epoch = "source-2".into();
    let resync = v5::ResyncRequired {
        scope: changed.scope.clone(),
        source_epoch: changed.source_epoch.clone(),
        message_id: None,
    };
    let event = established_frame(
        v5::frame::Body::EventBatch(changed),
        v5::LedgerClass::Event,
        1,
    );
    assert_eq!(
        client.receive(event.clone(), event.encoded_len() as u64, 4),
        vec![Decision::Resync(resync)]
    );
    let end = established_frame(stream_end("sub"), v5::LedgerClass::Event, 2);
    let decisions = client.receive(end.clone(), end.encoded_len() as u64, 4);
    assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
    assert!(
        decisions
            .iter()
            .all(|decision| !matches!(decision, Decision::StreamComplete(_)))
    );
    assert_eq!(client.stats().retained_bytes, 0);
}

#[test]
fn parity_receiver_stream_end_rejects_unresolved_control() {
    let (mut client, _) = subscribed_pair(Budgets::default());
    let resync = v5::ResyncRequired {
        scope: batch("a").scope,
        source_epoch: "source".into(),
        message_id: None,
    };
    let control = established_frame(
        v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::ResyncRequired(resync.clone())),
        }),
        v5::LedgerClass::Normal,
        2,
    );
    assert_eq!(
        client.receive(control.clone(), control.encoded_len() as u64, 4),
        vec![Decision::Resync(resync)]
    );
    let end = established_frame(stream_end("sub"), v5::LedgerClass::Event, 1);
    let decisions = client.receive(end.clone(), end.encoded_len() as u64, 4);
    assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
    assert!(
        decisions
            .iter()
            .all(|decision| !matches!(decision, Decision::StreamComplete(_)))
    );
    assert_eq!(client.stats().retained_bytes, 0);
}

#[test]
fn parity_unknown_and_wrong_direction_producing_stream_end_are_terminal() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    assert_eq!(
        server.queue_frame(stream_end("unknown"), 4),
        Err(ProtocolError::Malformed)
    );
    assert!(server.machine.take_decisions().iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
    assert_eq!(
        client.queue_frame(stream_end("sub"), 4),
        Err(ProtocolError::Direction)
    );
    assert!(client.machine.take_decisions().iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Direction)));
}

#[test]
fn parity_prepared_end_rechecks_a_new_scoped_resync_before_handoff() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    server.queue_frame(stream_end("sub"), 4).unwrap();
    let prepared = server.machine.prepare_handoff(4).unwrap();
    let bytes = prepared.frame().encoded_len() as u64;
    server
        .queue_frame(
            v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::ResyncRequired(v5::ResyncRequired {
                    scope: batch("a").scope,
                    source_epoch: "canonical".into(),
                    message_id: None,
                })),
            }),
            4,
        )
        .unwrap();
    assert!(
        server
            .machine
            .handoff(prepared, bytes, 4)
            .unwrap()
            .iter()
            .all(|decision| !matches!(decision, Decision::Send(_)))
    );
    assert_eq!(server.stats().prepared_bytes, 0);
    assert!(matches!(
        send(server.poll(4)).body,
        Some(v5::frame::Body::Control(_))
    ));
    assert!(server.poll(4).is_empty());
}

#[test]
fn parity_canonical_hydration_selects_neither_ready_nor_buffered_epoch() {
    let (mut client, _) = subscribed_pair(Budgets::default());
    client.begin_hydration("sub").unwrap();
    let mut buffered = batch("during");
    buffered.source_epoch = "event-epoch".into();
    let frame = established_frame(
        v5::frame::Body::EventBatch(buffered),
        v5::LedgerClass::Event,
        1,
    );
    assert!(
        client
            .receive(frame.clone(), frame.encoded_len() as u64, 4)
            .is_empty()
    );
    assert_eq!(
        client
            .machine
            .complete_hydration("sub", "canonical".into(), 4)
            .unwrap(),
        vec![Decision::Resync(v5::ResyncRequired {
            scope: batch("a").scope,
            source_epoch: "event-epoch".into(),
            message_id: None
        })]
    );
    client.begin_hydration("sub").unwrap();
    assert!(
        client
            .machine
            .complete_hydration("sub", "canonical".into(), 4)
            .unwrap()
            .is_empty()
    );
    let mut live = batch("after");
    live.source_epoch = "canonical".into();
    let frame = established_frame(
        v5::frame::Body::EventBatch(live.clone()),
        v5::LedgerClass::Event,
        2,
    );
    assert_eq!(
        client.receive(frame.clone(), frame.encoded_len() as u64, 4),
        vec![Decision::Events(live)]
    );
    let frame = established_frame(
        v5::frame::Body::EventBatch(batch("old-ready")),
        v5::LedgerClass::Event,
        3,
    );
    assert!(
        client
            .receive(frame.clone(), frame.encoded_len() as u64, 4)
            .iter()
            .any(|decision| matches!(decision, Decision::Resync(_)))
    );
}

#[test]
fn parity_inflight_resync_keeps_the_fence_after_that_hydration_returns() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    client.begin_hydration("sub").unwrap();
    server
        .queue_frame(
            v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::ResyncRequired(v5::ResyncRequired {
                    scope: batch("a").scope,
                    source_epoch: "canonical".into(),
                    message_id: None,
                })),
            }),
            4,
        )
        .unwrap();
    let frame = send(server.poll(4));
    client.receive(frame.clone(), frame.encoded_len() as u64, 4);
    assert!(
        client
            .machine
            .complete_hydration("sub", "canonical".into(), 4)
            .unwrap()
            .iter()
            .any(|decision| matches!(decision, Decision::Resync(_)))
    );
    let end = established_frame(stream_end("sub"), v5::LedgerClass::Event, 1);
    assert!(client.receive(end.clone(), end.encoded_len() as u64, 4).iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
}

#[test]
fn parity_relay_hydration_adopts_only_the_canonical_epoch_mid_connection() {
    for changed in [true, false] {
        let mut descriptor = generated_events_descriptor();
        descriptor.roles = vec![v5::PeerRole::Relay as i32];
        let (mut upstream, mut relay) =
            role_pair(v5::PeerRole::Agent, v5::PeerRole::Relay, vec![descriptor]);
        subscribe_target(&mut relay, &mut upstream, batch("a").scope, "sub", 3);
        relay.begin_hydration("sub").unwrap();
        let canonical = if changed { "upstream-2" } else { "upstream-1" };
        let mut expected = Vec::new();
        let mut buffered_bytes = 0;
        for (index, epoch) in ["upstream-1", canonical, "upstream-1", canonical]
            .into_iter()
            .enumerate()
        {
            let mut during = batch(&format!("during-{index}"));
            during.source_epoch = epoch.into();
            expected.push(if epoch == canonical {
                Decision::Events(during.clone())
            } else {
                Decision::Resync(v5::ResyncRequired {
                    scope: during.scope.clone(),
                    source_epoch: epoch.into(),
                    message_id: None,
                })
            });
            let frame = established_frame(
                v5::frame::Body::EventBatch(during),
                v5::LedgerClass::Event,
                index as u64 + 1,
            );
            buffered_bytes += frame.encoded_len() as u64;
            assert!(
                relay
                    .receive(frame.clone(), frame.encoded_len() as u64, 4)
                    .is_empty()
            );
        }
        assert_eq!(relay.stats().hydration_bytes, buffered_bytes);
        assert_eq!(
            relay
                .complete_hydration("sub", canonical.into(), 4)
                .unwrap(),
            expected
        );
        assert_eq!(relay.stats().hydration_bytes, 0);
        let mut live = batch("new-epoch");
        live.source_epoch = canonical.into();
        let live = established_frame(v5::frame::Body::EventBatch(live), v5::LedgerClass::Event, 5);
        assert_eq!(
            relay.receive(live.clone(), live.encoded_len() as u64, 4),
            vec![Decision::Forward(live)]
        );
        let mut old = batch("old-epoch");
        old.source_epoch = if changed { "upstream-1" } else { "source" }.into();
        let expected = v5::ResyncRequired {
            scope: old.scope.clone(),
            source_epoch: old.source_epoch.clone(),
            message_id: None,
        };
        let old = established_frame(v5::frame::Body::EventBatch(old), v5::LedgerClass::Event, 6);
        assert_eq!(
            relay.receive(old.clone(), old.encoded_len() as u64, 4),
            vec![Decision::Resync(expected)]
        );
    }
}

#[test]
fn parity_hydration_rejects_an_empty_canonical_epoch_without_discarding_buffered_events() {
    let (mut client, _) = subscribed_pair(Budgets::default());
    client.begin_hydration("sub").unwrap();
    let buffered = batch("buffered");
    let frame = established_frame(
        v5::frame::Body::EventBatch(buffered.clone()),
        v5::LedgerClass::Event,
        1,
    );
    assert!(
        client
            .receive(frame.clone(), frame.encoded_len() as u64, 4)
            .is_empty()
    );
    let before = client.stats();
    assert_eq!(
        client.complete_hydration("sub", String::new(), 4),
        Err(ProtocolError::Epoch)
    );
    assert_eq!(client.stats(), before);
    assert_eq!(
        client
            .complete_hydration("sub", "source".into(), 4)
            .unwrap(),
        vec![Decision::Events(buffered)]
    );
    assert_eq!(client.stats().hydration_bytes, 0);
}

#[test]
fn parity_hydration_completion_for_an_unknown_subscription_is_a_caller_error() {
    let (mut client, _) = subscribed_pair(Budgets::default());
    let before = client.stats();
    assert_eq!(
        client.complete_hydration("unknown", "snapshot-epoch".into(), 4),
        Err(ProtocolError::Unknown)
    );
    assert_eq!(client.stats(), before);
    assert!(client.machine.take_decisions().is_empty());
    let live = established_frame(
        v5::frame::Body::EventBatch(batch("live")),
        v5::LedgerClass::Event,
        1,
    );
    assert_eq!(
        client.receive(live.clone(), live.encoded_len() as u64, 4),
        vec![Decision::Events(batch("live"))]
    );
}

#[test]
fn parity_hydration_byte_overflow_resyncs_or_native_admission_closes_with_limit() {
    for native_limit in [false, true] {
        let frame = established_frame(
            v5::frame::Body::EventBatch(batch("overflow")),
            v5::LedgerClass::Event,
            1,
        );
        let (mut client, _) = subscribed_pair(Budgets {
            event_queue_bytes: if native_limit {
                Budgets::default().event_queue_bytes
            } else {
                frame.encoded_len() as u64 - 1
            },
            ..Budgets::default()
        });
        client.begin_hydration("sub").unwrap();
        let budget = client.machine.reservation();
        let external = if native_limit {
            let pool = budget.borrow();
            pool.limit() - pool.used()
        } else {
            0
        };
        assert!(budget.borrow_mut().reserve(external));
        let decisions = client.receive(frame.clone(), frame.encoded_len() as u64, 4);
        if native_limit {
            assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Limit)));
            assert_eq!(client.stats().retained_bytes, 0);
            assert_eq!(budget.borrow().used(), external);
        } else {
            assert_eq!(
                decisions,
                vec![Decision::Resync(v5::ResyncRequired {
                    scope: batch("a").scope,
                    source_epoch: "source".into(),
                    message_id: None
                })]
            );
            assert_eq!(
                client.complete_hydration("sub", "source".into(), 4),
                Err(ProtocolError::Malformed)
            );
        }
        assert_eq!(client.stats().hydration_bytes, 0);
        assert!(decisions.iter().all(|decision| !matches!(
            decision,
            Decision::Events(_) | Decision::StreamComplete(_)
        )));
        budget.borrow_mut().release(external).unwrap();
    }
}

#[test]
fn boundary_prepared_request_reuses_ordinal_and_remains_unsent_until_handoff() {
    let (mut client, _) = pair();
    let id = stop(&mut client, 4);
    let first = client.machine.prepare_handoff(4).unwrap();
    assert_eq!(first.frame().delivery_ordinal, Some(1));
    assert_eq!(client.stats().handed_bytes[0], 0);
    client.machine.abort_prepared(first).unwrap();
    let second = client.machine.prepare_handoff(4).unwrap();
    assert_eq!(second.frame().delivery_ordinal, Some(1));
    assert_eq!(
        client.machine.cancel_request(&id, 4).unwrap(),
        vec![Decision::Settled {
            request_id: id,
            outcome: Outcome::Unsent
        }]
    );
    assert_eq!(client.stats().handed_bytes[0], 0);
    assert_eq!(client.stats().queued_bytes[0], 0);
    assert_eq!(
        client.machine.handoff(second, 50, 4),
        Err(ProtocolError::Unknown)
    );
}

#[test]
fn boundary_completed_bulk_remains_charged_until_release_without_a_second_data_copy() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    let data = v5::BrowserStopResult { data: v5::Empty {} }.encode_to_vec();
    let mut settled = Vec::new();
    for body in [
        v5::frame::Body::BulkStart(v5::BulkStart {
            request_id: id,
            transfer_id: "transfer".into(),
            operation_id: 3009,
            type_name: "ycoding.v5.browser_stop_Result".into(),
            content_kind: v5::ContentKind::TypedMessage as i32,
            byte_count: data.len() as u64,
            chunk_count: 1,
        }),
        v5::frame::Body::BulkPiece(v5::BulkPiece {
            transfer_id: "transfer".into(),
            index: 0,
            offset: 0,
            data: data.clone(),
        }),
        v5::frame::Body::BulkEnd(v5::BulkEnd {
            transfer_id: "transfer".into(),
            byte_count: data.len() as u64,
            outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
        }),
    ] {
        server.queue_frame(body, 5).unwrap();
        let frame = send(server.poll(5));
        settled.extend(client.receive(frame.clone(), frame.encoded_len() as u64, 5));
    }
    let bytes = settled
        .into_iter()
        .find_map(|decision| match decision {
            Decision::Settled {
                outcome: Outcome::BulkSuccess { bytes, .. },
                ..
            } => Some(bytes),
            _ => None,
        })
        .unwrap();
    assert_eq!(bytes.as_ref(), &data);
    assert_eq!(std::rc::Rc::strong_count(&bytes), 2);
    assert_eq!(client.stats().reassembly_reserved_bytes, data.len() as u64);
    let budget = client.machine.reservation();
    let before = budget.borrow().used();
    assert_eq!(before, client.stats().retained_bytes);
    client.machine.release_bulk("transfer").unwrap();
    assert_eq!(budget.borrow().used(), before - data.len() as u64);
    assert_eq!(client.stats().reassembly_reserved_bytes, 0);
    assert_eq!(std::rc::Rc::strong_count(&bytes), 1);
}

#[test]
fn boundary_relay_cancel_refunds_no_unreserved_assembly_bytes() {
    for request_cancel in [false, true] {
        let (mut agent, mut relay) =
            role_pair(v5::PeerRole::Agent, v5::PeerRole::Relay, OPERATIONS.clone());
        let id = workspace_list(&mut relay, 4);
        let request = send(relay.poll(4));
        agent.receive(request.clone(), request.encoded_len() as u64, 4);
        agent
            .queue_frame(
                v5::frame::Body::BulkStart(v5::BulkStart {
                    request_id: id.clone(),
                    transfer_id: "transfer".into(),
                    operation_id: 5006,
                    type_name: "ycoding.v5.workspace_list_Result".into(),
                    content_kind: v5::ContentKind::TypedMessage as i32,
                    byte_count: 4096,
                    chunk_count: 1,
                }),
                5,
            )
            .unwrap();
        let frame = send(agent.poll(5));
        assert_eq!(
            relay.receive(frame.clone(), frame.encoded_len() as u64, 5),
            vec![Decision::Forward(frame)]
        );
        assert_eq!(relay.stats().reassembly_reserved_bytes, 0);
        let decisions = if request_cancel {
            relay.machine.cancel_request(&id, 5)
        } else {
            relay.machine.cancel_transfer("transfer", 5)
        };
        assert_eq!(
            decisions.unwrap(),
            vec![Decision::Settled {
                request_id: id,
                outcome: Outcome::Unknown
            }]
        );
        assert_eq!(relay.stats().reassembly_reserved_bytes, 0);
        assert_eq!(
            relay.stats().retained_bytes,
            relay.machine.reservation().borrow().used()
        );
        relay.disconnect(false);
        assert_eq!(relay.machine.reservation().borrow().used(), 0);
    }
}

#[test]
fn parity_oversize_event_becomes_metadata_invalidation_after_prior_event_consumption() {
    for message_id in [None, Some("snapshot-progress".to_string())] {
        let (mut client, mut server) = subscribed_pair(Budgets::default());
        server
            .queue_events(batch("before"), v5::PriorityMode::Background, 4)
            .unwrap();
        let expected = v5::ResyncRequired {
            scope: batch("a").scope,
            source_epoch: "metadata-epoch".into(),
            message_id,
        };
        server
            .machine
            .enqueue_event(
                large_event(262144),
                EventMetadata {
                    subscription_id: "sub".into(),
                    scope: expected.scope.clone(),
                    source_epoch: expected.source_epoch.clone(),
                    message_id: expected.message_id.clone(),
                    priority: v5::PriorityMode::Interactive,
                },
                4,
            )
            .unwrap();
        assert_eq!(server.stats().oversized_invalidations, 1);
        let before = send(server.poll(4));
        assert_eq!(
            before.body,
            Some(v5::frame::Body::EventBatch(batch("before")))
        );
        assert!(server.poll(4).is_empty());
        assert_eq!(
            client.receive(before.clone(), before.encoded_len() as u64, 4),
            vec![Decision::Events(batch("before"))]
        );
        client
            .machine
            .consume(v5::LedgerClass::Event, before.delivery_ordinal.unwrap(), 4)
            .unwrap();
        let credit = send(client.poll(29));
        server.receive(credit.clone(), credit.encoded_len() as u64, 29);
        let invalidation = send(server.poll(29));
        assert_eq!(invalidation.ledger, Some(v5::LedgerClass::Normal as i32));
        assert_eq!(
            invalidation.body,
            Some(v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::ResyncRequired(expected.clone()))
            }))
        );
        assert_eq!(server.stats().queued_bytes[0], 0);
        assert!(server.poll(29).is_empty());
        assert_eq!(
            client.receive(invalidation.clone(), invalidation.encoded_len() as u64, 29),
            vec![Decision::Resync(expected.clone())]
        );
        client.machine.begin_hydration("sub").unwrap();
        assert!(
            client
                .machine
                .complete_hydration("sub", expected.source_epoch.clone(), 29)
                .unwrap()
                .is_empty()
        );
        push_individual_event(
            &mut server,
            batch("after").events.remove(0),
            event_metadata(
                "sub",
                "session",
                &expected.source_epoch,
                v5::PriorityMode::Interactive,
            ),
            30,
        )
        .unwrap();
        let after = send(server.poll(70));
        let mut expected_after = batch("after");
        expected_after.source_epoch = expected.source_epoch;
        assert_eq!(
            after.body,
            Some(v5::frame::Body::EventBatch(expected_after.clone()))
        );
        assert_eq!(
            client.receive(after.clone(), after.encoded_len() as u64, 70),
            vec![Decision::Events(expected_after)]
        );
        assert_eq!(server.stats().oversized_invalidations, 1);
        assert!(server.poll(70).is_empty());
        assert!(
            !server
                .machine
                .take_decisions()
                .iter()
                .any(|decision| matches!(decision, Decision::Closed(_)))
        );
    }
}

#[test]
fn parity_oversize_invalidation_closes_with_limit_when_normal_admission_cannot_fit() {
    for full_queue in [true, false] {
        let (_, mut server) = subscribed_pair(Budgets {
            normal_window_bytes: 160,
            ..Budgets::default()
        });
        if full_queue {
            let filler = v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::InventoryInvalidated(
                    v5::InventoryInvalidated {},
                )),
            });
            let reserve = server.reserve(filler.clone());
            let count = Budgets::default().normal_queue_bytes / reserve;
            for _ in 0..count {
                server.queue_frame(filler.clone(), 4).unwrap();
            }
            assert_eq!(server.stats().queued_bytes[0], count * reserve);
        }
        let metadata = EventMetadata {
            subscription_id: "sub".into(),
            scope: batch("a").scope,
            source_epoch: "source".into(),
            message_id: if full_queue {
                None
            } else {
                Some("m".repeat(128))
            },
            priority: v5::PriorityMode::Interactive,
        };
        assert_eq!(
            server
                .machine
                .enqueue_event(large_event(262144), metadata, 4),
            Err(ProtocolError::Limit)
        );
        assert_eq!(server.machine.take_decisions().iter().filter(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Limit)).count(), 1);
        assert_eq!(server.stats().retained_bytes, 0);
        assert_eq!(server.stats().queued_bytes, [0; 4]);
        assert_eq!(server.stats().oversized_invalidations, 0);
        assert!(server.poll(4).is_empty());
    }
}

#[test]
fn parity_unadmittable_oversize_invalidation_closes_only_its_owner() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    let budget = server.machine.reservation();
    let external = {
        let budget = budget.borrow();
        budget.limit() - budget.used() - 50
    };
    assert!(budget.borrow_mut().reserve(external));
    let metadata = EventMetadata {
        subscription_id: "sub".into(),
        scope: batch("a").scope,
        source_epoch: "source".into(),
        message_id: None,
        priority: v5::PriorityMode::Interactive,
    };
    assert_eq!(
        server.machine.enqueue_event(
            v5::EventRecord {
                event_id: "oversized".into(),
                created_ms: 0,
                durable: None,
                event: v5::TypedPayload {
                    type_name: v5::LosslessString::full_name(),
                    payload: ycoding_protocol::encode_lossless(&vec![97; 262144]).encode_to_vec()
                }
            },
            metadata,
            4
        ),
        Err(ProtocolError::Limit)
    );
    assert!(server.machine.take_decisions().iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Limit)));
    assert_eq!(budget.borrow().used(), external);
    budget.borrow_mut().release(external).unwrap();
}

#[test]
fn boundary_inventory_revocation_refunds_endpoint_assembly_immediately() {
    let (mut browser, mut relay) = role_pair(
        v5::PeerRole::RemoteClient,
        v5::PeerRole::Relay,
        OPERATIONS.clone(),
    );
    browser.replace_authority(BTreeSet::from(["session".into()]), BTreeSet::new());
    relay.replace_authority(BTreeSet::from(["session".into()]), BTreeSet::new());
    let id = browser
        .request(
            4063,
            batch("a").scope,
            v5::SessionSnapshotRequest {
                params: v5::SessionSnapshotRequestParams {
                    session_id: ycoding_protocol::encode_lossless(
                        &"session".encode_utf16().collect::<Vec<_>>(),
                    ),
                },
                query: v5::SessionSnapshotQuery {
                    before: None,
                    limit: None,
                },
            }
            .encode_to_vec(),
            4,
        )
        .unwrap();
    let request = send(browser.poll(4));
    relay.receive(request.clone(), request.encoded_len() as u64, 4);
    relay
        .queue_frame(
            v5::frame::Body::BulkStart(v5::BulkStart {
                request_id: id,
                transfer_id: "transfer".into(),
                operation_id: 4063,
                type_name: "ycoding.v5.session_snapshot_Result".into(),
                content_kind: v5::ContentKind::TypedMessage as i32,
                byte_count: 4096,
                chunk_count: 1,
            }),
            5,
        )
        .unwrap();
    let start = send(relay.poll(5));
    browser.receive(start.clone(), start.encoded_len() as u64, 5);
    assert_eq!(browser.stats().reassembly_reserved_bytes, 4096);
    let before = browser.machine.reservation().borrow().used();
    browser.replace_authority(BTreeSet::new(), BTreeSet::new());
    assert_eq!(browser.stats().reassembly_reserved_bytes, 0);
    assert_eq!(browser.machine.reservation().borrow().used(), before - 4096);
}

#[test]
fn boundary_prepared_authority_is_rechecked_before_transmission() {
    let (mut client, _) = pair();
    let id = stop(&mut client, 4);
    let prepared = client.machine.prepare_handoff(4).unwrap();
    let bytes = prepared.frame().encoded_len() as u64;
    client.machine.update_authority(1, true, 4, 4403).unwrap();
    let decisions = client.machine.handoff(prepared, bytes, 4).unwrap();
    assert!(decisions.contains(&Decision::Settled {
        request_id: id,
        outcome: Outcome::Unsent
    }));
    assert!(
        decisions
            .iter()
            .any(|decision| matches!(decision, Decision::Closed(close) if close.code == 4403))
    );
    assert!(
        decisions
            .iter()
            .all(|decision| !matches!(decision, Decision::Send(_)))
    );
    assert_eq!(client.stats().retained_bytes, 0);
}

#[test]
fn boundary_prepared_events_remain_in_the_queue_count_budget() {
    let (mut client, mut server) = pair_with(Budgets {
        event_queue_count: 2,
        ..Budgets::default()
    });
    subscribe_target(&mut client, &mut server, batch("a").scope, "sub", 3);
    let mut full = batch("first");
    full.events.push(batch("second").events.remove(0));
    server
        .queue_events(full, v5::PriorityMode::Interactive, 4)
        .unwrap();
    let prepared = server.machine.prepare_handoff(44).unwrap();
    assert_eq!(
        server.queue_events(batch("third"), v5::PriorityMode::Interactive, 44),
        Err(ProtocolError::Limit)
    );
    server.machine.abort_prepared(prepared).unwrap();
}

#[test]
fn boundary_prepared_ping_prevents_a_second_live_heartbeat() {
    let (_, mut server) = pair();
    let prepared = server.machine.prepare_handoff(20003).unwrap();
    assert!(matches!(
        prepared.frame().body,
        Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Ping(_))
        }))
    ));
    assert!(server.machine.advance(20004).is_empty());
    let bytes = prepared.frame().encoded_len() as u64;
    server.machine.handoff(prepared, bytes, 20004).unwrap();
    assert!(server.poll(20004).is_empty());
}

#[test]
fn boundary_fair_handoff_abort_credit_and_epoch_teardown_share_one_ownership_chain() {
    let (mut client, mut server) = pair();
    for session in ["a", "b"] {
        subscribe_target(
            &mut client,
            &mut server,
            v5::Scope {
                target: Some(v5::scope::Target::Session(session.into())),
            },
            session,
            3,
        );
    }
    for session in ["a", "a", "b"] {
        for index in 0..64 {
            push_individual_event(
                &mut server,
                batch(&format!("{session}-{index}")).events.remove(0),
                event_metadata(session, session, "source", v5::PriorityMode::Interactive),
                4,
            )
            .unwrap();
        }
    }
    let first = server.machine.prepare_handoff(4).unwrap();
    assert_eq!(first.frame().delivery_ordinal, Some(1));
    assert!(server.machine.prepare_handoff(4).is_none());
    server.machine.abort_prepared(first).unwrap();
    let first = server.machine.prepare_handoff(4).unwrap();
    assert_eq!(first.frame().delivery_ordinal, Some(1));
    let first_bytes = first.frame().encoded_len() as u64;
    let first_frame = send(server.machine.handoff(first, first_bytes, 4).unwrap());
    assert!(
        matches!(&first_frame.body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == "a")
    );
    let second = server.machine.prepare_handoff(4).unwrap();
    assert_eq!(second.frame().delivery_ordinal, Some(2));
    let second_bytes = second.frame().encoded_len() as u64;
    let second_frame = send(server.machine.handoff(second, second_bytes, 4).unwrap());
    assert!(
        matches!(&second_frame.body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == "b")
    );
    assert_eq!(server.stats().handed_bytes[1], first_bytes + second_bytes);
    client.receive(first_frame.clone(), first_bytes, 4);
    assert_eq!(
        client
            .machine
            .consume(v5::LedgerClass::Event, 1, 4)
            .unwrap(),
        first_bytes
    );
    let credit = send(client.poll(29));
    server.receive(credit.clone(), credit.encoded_len() as u64, 29);
    assert_eq!(server.stats().handed_bytes[1], second_bytes);
    let third = server.machine.prepare_handoff(29).unwrap();
    assert_eq!(third.frame().delivery_ordinal, Some(3));
    let mut stale = established_frame(
        v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Ping(v5::Ping { id: 2 })),
        }),
        v5::LedgerClass::Tiny,
        3,
    );
    stale.connection_epoch = Some("old-epoch".into());
    let decisions = server.receive(stale.clone(), stale.encoded_len() as u64, 29);
    assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Epoch)));
    assert_eq!(server.stats().retained_bytes, 0);
    assert_eq!(server.stats().prepared_bytes, 0);
    assert_eq!(server.stats().queued_bytes, [0; 4]);
    assert_eq!(server.stats().handed_bytes, [0; 4]);
    assert_eq!(server.machine.reservation().borrow().used(), 0);
    assert_eq!(
        server.machine.handoff(third, 50, 29),
        Err(ProtocolError::Unknown)
    );
}

#[test]
fn parity_event_payload_requires_explicit_allowlist_and_strict_generated_validation() {
    for outside_allowlist in [true, false] {
        let (mut client, _) = subscribed_pair(Budgets::default());
        let mut event = batch("invalid");
        event.events[0].event = if outside_allowlist {
            v5::TypedPayload {
                type_name: v5::Empty::full_name(),
                payload: v5::Empty {}.encode_to_vec(),
            }
        } else {
            v5::TypedPayload {
                type_name: v5::HealthGetRequest::full_name(),
                payload: vec![0],
            }
        };
        let frame = established_frame(
            v5::frame::Body::EventBatch(event),
            v5::LedgerClass::Event,
            1,
        );
        let decisions = client.receive(frame.clone(), frame.encoded_len() as u64, 4);
        assert!(
            decisions
                .iter()
                .all(|decision| !matches!(decision, Decision::Events(_) | Decision::Forward(_)))
        );
        assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
        assert_eq!(client.stats().retained_bytes, 0);
    }
}

fn stop_bulk_start(request_id: String, transfer_id: &str) -> v5::frame::Body {
    v5::frame::Body::BulkStart(v5::BulkStart {
        request_id,
        transfer_id: transfer_id.into(),
        operation_id: 3009,
        type_name: v5::BrowserStopResult::full_name(),
        content_kind: v5::ContentKind::TypedMessage as i32,
        byte_count: 2,
        chunk_count: 1,
    })
}

#[test]
fn bulk_cancel_releases_a_slot_before_the_next_start_and_preserves_the_two_transfer_cap() {
    for cancel in [false, true] {
        let (mut client, _) = pair();
        let ids = (0..3)
            .map(|_| {
                let id = stop(&mut client, 4);
                send(client.poll(4));
                id
            })
            .collect::<Vec<_>>();
        for (index, id) in ids.iter().take(2).enumerate() {
            let start = established_frame(
                stop_bulk_start(id.clone(), &format!("transfer-{index}")),
                v5::LedgerClass::Normal,
                index as u64 + 1,
            );
            assert!(
                client
                    .receive(start.clone(), start.encoded_len() as u64, 5)
                    .is_empty()
            );
        }
        assert_eq!(client.stats().reassembly_reserved_bytes, 4);
        if cancel {
            assert!(
                client
                    .machine
                    .cancel_transfer("transfer-0", 5)
                    .unwrap()
                    .contains(&Decision::Settled {
                        request_id: ids[0].clone(),
                        outcome: Outcome::Unknown
                    })
            );
            assert_eq!(client.stats().reassembly_reserved_bytes, 2);
        }
        let start = established_frame(
            stop_bulk_start(ids[2].clone(), "transfer-2"),
            v5::LedgerClass::Normal,
            3,
        );
        let decisions = client.receive(start.clone(), start.encoded_len() as u64, 5);
        if cancel {
            assert!(decisions.is_empty());
            assert_eq!(client.stats().reassembly_reserved_bytes, 4);
        }
        if !cancel {
            assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Limit)));
        }
    }
}

#[test]
fn bulk_cancel_orphans_are_counted_without_resurrection_and_refund_exact_handed_credit() {
    let (mut client, mut server) = pair();
    let id = stop(&mut client, 4);
    let request = send(client.poll(4));
    server.receive(request.clone(), request.encoded_len() as u64, 4);
    server
        .queue_frame(stop_bulk_start(id.clone(), "transfer"), 5)
        .unwrap();
    let start = send(server.poll(5));
    client.receive(start.clone(), start.encoded_len() as u64, 5);
    let data = v5::BrowserStopResult { data: v5::Empty {} }.encode_to_vec();
    server
        .queue_frame(
            v5::frame::Body::BulkPiece(v5::BulkPiece {
                transfer_id: "transfer".into(),
                index: 0,
                offset: 0,
                data,
            }),
            5,
        )
        .unwrap();
    server
        .queue_frame(
            v5::frame::Body::BulkEnd(v5::BulkEnd {
                transfer_id: "transfer".into(),
                byte_count: 2,
                outcome: Some(v5::bulk_end::Outcome::Success(v5::Empty {})),
            }),
            5,
        )
        .unwrap();
    let piece = send(server.poll(5));
    let end = send(server.poll(5));
    assert_eq!(server.stats().handed_bytes[2], piece.encoded_len() as u64);
    assert_eq!(
        client.machine.cancel_transfer("transfer", 6).unwrap(),
        vec![Decision::Settled {
            request_id: id,
            outcome: Outcome::Unknown
        }]
    );
    for (index, frame) in [piece, end].into_iter().enumerate() {
        let encoded = frame.encode_to_vec();
        let budget = client.machine.reservation();
        let before = budget.borrow().used();
        let token = client.machine.admit_incoming(encoded.len() as u64).unwrap();
        assert_eq!(budget.borrow().used(), before + encoded.len() as u64);
        assert_eq!(client.stats().admitted_bytes, encoded.len() as u64);
        let decoded = ycoding_protocol::decode_strict::<v5::Frame>(&encoded).unwrap();
        assert!(
            client
                .machine
                .accept_incoming(&token, decoded, 6)
                .unwrap()
                .is_empty()
        );
        assert_eq!(client.stats().dropped_transfers, index as u64 + 1);
        assert_eq!(budget.borrow().used(), before);
        assert_eq!(client.stats().reassembly_reserved_bytes, 0);
        assert_eq!(client.stats().reassembly_received_bytes, 0);
        assert_eq!(client.stats().pending_requests, 0);
    }
    let mut credits = Vec::new();
    loop {
        let decisions = client.poll(31);
        let Some(frame) = decisions.into_iter().find_map(|decision| match decision {
            Decision::Send(frame) => Some(frame),
            _ => None,
        }) else {
            break;
        };
        if let Some(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::Credit(credit)),
        })) = &frame.body
        {
            credits.push((credit.ledger, credit.consumed_through));
        }
        server.receive(frame.clone(), frame.encoded_len() as u64, 31);
    }
    assert!(credits.contains(&(v5::LedgerClass::Bulk as i32, 1)));
    assert!(credits.contains(&(v5::LedgerClass::Normal as i32, 2)));
    assert_eq!(server.stats().handed_bytes[2], 0);
    assert_eq!(server.stats().handed_bytes[0], 0);
    assert_eq!(client.stats().dropped_transfers, 2);
}

#[test]
fn bulk_cancel_releases_ownership_even_when_tiny_flow_has_no_room() {
    let (mut client, _) = pair();
    let id = stop(&mut client, 4);
    send(client.poll(4));
    let start = established_frame(
        stop_bulk_start(id.clone(), "transfer"),
        v5::LedgerClass::Normal,
        1,
    );
    client.receive(start.clone(), start.encoded_len() as u64, 5);
    for ordinal in 2..=33 {
        let ping = established_frame(
            v5::frame::Body::Control(v5::Control {
                kind: Some(v5::control::Kind::Ping(v5::Ping { id: ordinal })),
            }),
            v5::LedgerClass::Tiny,
            ordinal,
        );
        assert!(
            client
                .receive(ping.clone(), ping.encoded_len() as u64, 5)
                .is_empty()
        );
    }
    assert_eq!(client.stats().queued_bytes[3], 16384);
    assert_eq!(
        client.machine.cancel_transfer("transfer", 5).unwrap(),
        vec![Decision::Settled {
            request_id: id,
            outcome: Outcome::Unknown
        }]
    );
    assert_eq!(client.stats().reassembly_reserved_bytes, 0);
    assert_eq!(client.stats().pending_requests, 0);
    assert_eq!(client.stats().queued_bytes[3], 16384);
}

#[test]
fn bulk_start_for_a_non_live_or_untransmitted_request_is_a_protocol_failure() {
    for case in 0..3 {
        let (mut client, _) = pair();
        let id = if case == 0 {
            "future-request".into()
        } else {
            stop(&mut client, 4)
        };
        if case == 2 {
            send(client.poll(4));
            client.machine.cancel_request(&id, 4).unwrap();
        }
        let start = established_frame(stop_bulk_start(id, "transfer"), v5::LedgerClass::Normal, 1);
        let decisions = client.receive(start.clone(), start.encoded_len() as u64, 5);
        assert!(decisions.iter().all(|decision| !matches!(
            decision,
            Decision::Settled {
                outcome: Outcome::BulkSuccess { .. },
                ..
            }
        )));
        assert!(decisions.iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
        assert_eq!(client.stats().retained_bytes, 0);
    }
}

fn push_individual_event(
    server: &mut Binding,
    event: v5::EventRecord,
    metadata: EventMetadata,
    now: u64,
) -> Result<(), ProtocolError> {
    server.machine.enqueue_event(event, metadata, now)
}

fn event_metadata(
    subscription_id: &str,
    session: &str,
    source: &str,
    priority: v5::PriorityMode,
) -> EventMetadata {
    EventMetadata {
        subscription_id: subscription_id.into(),
        scope: v5::Scope {
            target: Some(v5::scope::Target::Session(session.into())),
        },
        source_epoch: source.into(),
        message_id: None,
        priority,
    }
}

#[test]
fn coalescing_individual_event_64_boundary_flushes_and_matches_generated_size() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    for index in 0..64 {
        let mut event = batch(&format!("event-{index}")).events.remove(0);
        event.created_ms = -1;
        event.durable = Some(v5::DurablePosition {
            aggregate_id: "aggregate🙂".into(),
            sequence: u64::MAX,
            version: u32::MAX,
        });
        push_individual_event(
            &mut server,
            event,
            event_metadata("sub", "session", "source", v5::PriorityMode::Background),
            4,
        )
        .unwrap();
    }
    let prepared = server
        .machine
        .prepare_handoff(4)
        .expect("64-event batch flushes now");
    let mut maximum = prepared.frame().clone();
    maximum.delivery_ordinal = Some(u64::MAX);
    maximum.tiny_consumed_through = Some(u64::MAX);
    assert_eq!(prepared.reserved_bytes(), maximum.encoded_len() as u64);
    assert!(
        matches!(prepared.frame().body.as_ref(), Some(v5::frame::Body::EventBatch(batch)) if batch.events.len() == 64)
    );
    let exact = prepared.frame().encoded_len() as u64;
    server.machine.handoff(prepared, exact, 4).unwrap();
}

#[test]
fn coalescing_prepared_arithmetic_size_matches_prost_at_every_header_varint_width() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    let mut event = batch("event🙂").events.remove(0);
    event.created_ms = -1;
    event.durable = Some(v5::DurablePosition {
        aggregate_id: "aggregate🙂".into(),
        sequence: u64::MAX,
        version: u32::MAX,
    });
    push_individual_event(
        &mut server,
        event,
        event_metadata("sub", "session", "source", v5::PriorityMode::Interactive),
        4,
    )
    .unwrap();
    let prepared = server.machine.prepare_handoff(44).unwrap();
    let magnitudes = [0, 1, u64::MAX]
        .into_iter()
        .chain(
            (7..64)
                .step_by(7)
                .flat_map(|bits| [(1_u64 << bits) - 1, 1_u64 << bits]),
        )
        .collect::<Vec<_>>();
    for ordinal in magnitudes.iter().copied().filter(|ordinal| *ordinal != 0) {
        for receipt in &magnitudes {
            let mut frame = prepared.frame().clone();
            frame.delivery_ordinal = Some(ordinal);
            frame.tiny_consumed_through = Some(*receipt);
            let batch = match frame.body.as_ref().unwrap() {
                v5::frame::Body::EventBatch(batch) => batch,
                _ => panic!("prepared event batch"),
            };
            let computed = ycoding_protocol::connection::event_frame_bytes(
                batch,
                frame.connection_epoch.as_deref().unwrap(),
                ordinal,
                *receipt,
            )
            .unwrap();
            let encoded = frame.encode_to_vec();
            assert_eq!(
                computed,
                encoded.len() as u64,
                "ordinal={ordinal}, receipt={receipt}"
            );
            assert!(computed <= prepared.reserved_bytes());
            if ordinal == u64::MAX && *receipt == u64::MAX {
                assert_eq!(computed, prepared.reserved_bytes());
            }
        }
    }
    server.machine.abort_prepared(prepared).unwrap();
}

#[test]
fn coalescing_one_open_batch_per_session_subscription_even_when_interleaved() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    subscribe_target(
        &mut client,
        &mut server,
        v5::Scope {
            target: Some(v5::scope::Target::Session("other".into())),
        },
        "other-sub",
        3,
    );
    for (id, sub, session) in [
        ("a1", "sub", "session"),
        ("b1", "other-sub", "other"),
        ("a2", "sub", "session"),
    ] {
        push_individual_event(
            &mut server,
            batch(id).events.remove(0),
            event_metadata(sub, session, "source", v5::PriorityMode::Interactive),
            4,
        )
        .unwrap();
    }
    let first = send(server.poll(44));
    assert!(
        matches!(first.body, Some(v5::frame::Body::EventBatch(batch)) if batch.events.iter().map(|event| event.event_id.as_str()).collect::<Vec<_>>() == ["a1", "a2"])
    );
    let second = send(server.poll(44));
    assert!(
        matches!(second.body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == "other-sub" && batch.events.len() == 1)
    );
    assert!(server.poll(44).is_empty());
}

#[test]
fn coalescing_source_change_flushes_prior_batch_and_starts_a_new_epoch() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    push_individual_event(
        &mut server,
        batch("old").events.remove(0),
        event_metadata("sub", "session", "source", v5::PriorityMode::Background),
        4,
    )
    .unwrap();
    push_individual_event(
        &mut server,
        batch("new").events.remove(0),
        event_metadata("sub", "session", "changed", v5::PriorityMode::Interactive),
        5,
    )
    .unwrap();
    assert!(
        matches!(send(server.poll(5)).body, Some(v5::frame::Body::EventBatch(batch)) if batch.source_epoch == "source")
    );
    assert!(server.poll(44).is_empty());
    assert!(
        matches!(send(server.poll(45)).body, Some(v5::frame::Body::EventBatch(batch)) if batch.source_epoch == "changed")
    );
}

#[test]
fn coalescing_formed_batch_is_not_an_outgoing_admission_api() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    assert_eq!(
        server.queue_frame(v5::frame::Body::EventBatch(batch("formed")), 4),
        Err(ProtocolError::Malformed)
    );
    assert!(server.machine.take_decisions().iter().any(|decision| matches!(decision, Decision::Closed(close) if close.category == ProtocolError::Malformed)));
}

fn large_event(units: usize) -> v5::EventRecord {
    v5::EventRecord {
        event_id: "large".into(),
        created_ms: 0,
        durable: None,
        event: v5::TypedPayload {
            type_name: v5::LosslessString::full_name(),
            payload: ycoding_protocol::encode_lossless(&vec![97; units]).encode_to_vec(),
        },
    }
}

#[test]
fn coalescing_complete_256_kib_boundary_splits_without_splitting_one_event() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    let mut low = 0;
    let mut high = 262144_usize;
    while low < high {
        let middle = (low + high).div_ceil(2);
        let complete = server.reserve(v5::frame::Body::EventBatch(v5::EventBatch {
            subscription_id: "sub".into(),
            scope: batch("a").scope,
            source_epoch: "source".into(),
            events: vec![large_event(middle)],
        }));
        if complete <= 262144 {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    push_individual_event(
        &mut server,
        large_event(low),
        event_metadata("sub", "session", "source", v5::PriorityMode::Background),
        4,
    )
    .unwrap();
    push_individual_event(
        &mut server,
        batch("next").events.remove(0),
        event_metadata("sub", "session", "source", v5::PriorityMode::Interactive),
        4,
    )
    .unwrap();
    let prepared = server
        .machine
        .prepare_handoff(4)
        .expect("complete-byte boundary flushes");
    let mut maximum = prepared.frame().clone();
    maximum.delivery_ordinal = Some(u64::MAX);
    maximum.tiny_consumed_through = Some(u64::MAX);
    assert_eq!(prepared.reserved_bytes(), maximum.encoded_len() as u64);
    assert_eq!(prepared.reserved_bytes(), 262144);
    let maximum_bytes = maximum.encode_to_vec();
    assert_eq!(maximum_bytes.len(), 262144);
    assert_eq!(
        ycoding_protocol::validate_binary(&v5::Frame::full_name(), &maximum_bytes),
        Ok(())
    );
    let mut overflow = maximum.clone();
    match overflow.body.as_mut().unwrap() {
        v5::frame::Body::EventBatch(event_batch) => {
            event_batch.events.push(batch("next").events.remove(0))
        }
        _ => panic!("prepared event batch"),
    }
    assert!(overflow.encoded_len() > 262144);
    assert_eq!(
        ycoding_protocol::validate_binary(&v5::Frame::full_name(), &overflow.encode_to_vec()),
        Err(ycoding_protocol::WireError("event batch bounds"))
    );
    assert!(
        matches!(prepared.frame().body.as_ref(), Some(v5::frame::Body::EventBatch(batch)) if batch.events.len() == 1 && batch.events[0].event.payload == large_event(low).event.payload)
    );
    let exact = prepared.frame().encoded_len() as u64;
    let emitted = send(server.machine.handoff(prepared, exact, 4).unwrap());
    assert!(emitted.encoded_len() <= 262144);
    assert!(server.poll(43).is_empty());
    assert!(
        matches!(send(server.poll(44)).body, Some(v5::frame::Body::EventBatch(batch)) if batch.events.len() == 1 && batch.events[0].event_id == "next")
    );
    push_individual_event(
        &mut server,
        large_event(low + 1),
        event_metadata("sub", "session", "source", v5::PriorityMode::Interactive),
        44,
    )
    .unwrap();
    assert_eq!(server.stats().oversized_invalidations, 1);
    assert_eq!(server.stats().queued_bytes[1], 0);
    assert!(server.stats().queued_bytes[0] > 0);
}

#[test]
fn coalescing_interactive_event_shortens_an_open_background_wait() {
    let (_, mut server) = subscribed_pair(Budgets::default());
    push_individual_event(
        &mut server,
        batch("background").events.remove(0),
        event_metadata("sub", "session", "source", v5::PriorityMode::Background),
        4,
    )
    .unwrap();
    push_individual_event(
        &mut server,
        batch("interactive").events.remove(0),
        event_metadata("sub", "session", "source", v5::PriorityMode::Interactive),
        5,
    )
    .unwrap();
    assert!(server.poll(44).is_empty());
    let frame = send(server.poll(45));
    assert!(
        matches!(frame.body, Some(v5::frame::Body::EventBatch(batch)) if batch.events.iter().map(|event| event.event_id.as_str()).collect::<Vec<_>>() == ["background", "interactive"])
    );
}

#[test]
fn coalescing_subscription_identity_change_flushes_prior_session_interest() {
    let (mut client, mut server) = subscribed_pair(Budgets::default());
    subscribe_target(&mut client, &mut server, batch("a").scope, "new-sub", 3);
    push_individual_event(
        &mut server,
        batch("old-interest").events.remove(0),
        event_metadata("sub", "session", "source", v5::PriorityMode::Background),
        4,
    )
    .unwrap();
    push_individual_event(
        &mut server,
        batch("new-interest").events.remove(0),
        event_metadata("new-sub", "session", "source", v5::PriorityMode::Background),
        5,
    )
    .unwrap();
    assert!(
        matches!(send(server.poll(5)).body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == "sub")
    );
    assert!(server.poll(754).is_empty());
    assert!(
        matches!(send(server.poll(755)).body, Some(v5::frame::Body::EventBatch(batch)) if batch.subscription_id == "new-sub")
    );
}
