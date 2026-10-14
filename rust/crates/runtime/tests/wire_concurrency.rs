mod support;

use prost::{Message, Name};
use std::time::Duration;
use support::*;
use tokio::{sync::oneshot, time::timeout};
use ycoding_protocol::{connection::Decision, v5};
use ycoding_runtime::{LocalAuth, standard};

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("wire flow exceeded its deadline")
}

async fn until(client: &mut Client, done: impl Fn(&Client) -> bool) {
    timeout(Duration::from_secs(10), async {
        while !done(client) {
            assert!(client.close.is_none(), "closed: {:?}", client.close);
            client.step().await;
        }
    })
    .await
    .expect("wire flow did not reach its completion signal");
}

async fn open(address: std::net::SocketAddr) -> Client {
    Client::open(address, &[("Authorization", basic("secret"))])
        .await
        .unwrap()
}

async fn subscribe(client: &mut Client, session: &str) -> String {
    let scope = session_scope(session);
    let request = client
        .send(
            "event.subscribe",
            global(),
            v5::EventSubscribeRequest {
                scope: scope.clone(),
            }
            .encode_to_vec(),
        )
        .await;
    client.subscribe_events(&request, scope).await
}

fn snapshot_request(session: &str) -> Vec<u8> {
    v5::SessionSnapshotRequest {
        params: v5::SessionSnapshotRequestParams {
            session_id: text(session),
        },
        query: v5::SessionSnapshotQuery {
            limit: Some(100),
            before: None,
        },
    }
    .encode_to_vec()
}

fn rename_request(session: &str, title: &str) -> Vec<u8> {
    v5::SessionRenameRequest {
        params: v5::SessionRenameRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionRenameRequestPayload { title: text(title) },
    }
    .encode_to_vec()
}

async fn rename(client: &mut Client, session: &str, title: &str) {
    let _: v5::SessionRenameResult = success(
        client
            .call(
                "session.rename",
                session_scope(session),
                rename_request(session, title),
            )
            .await,
    );
}

fn renamed(client: &Client, sub: &str) -> Vec<(String, u64, String)> {
    client
        .batches
        .iter()
        .filter(|batch| batch.subscription_id == sub)
        .flat_map(|batch| {
            assert_eq!(batch.source_epoch, client.source_epoch);
            &batch.events
        })
        .map(|record| {
            assert_eq!(record.event.type_name, v5::PublicEvent::full_name());
            let event = v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
            let Some(v5::public_event::Kind::SessionRenamed(event)) = event.kind else {
                panic!("unexpected event in isolated Session");
            };
            let durable = record.durable.as_ref().unwrap();
            assert_eq!(durable.aggregate_id, units(&event.data.session_id));
            assert_eq!(durable.sequence, event.durable.seq);
            assert_eq!(units(&event.source_epoch), client.source_epoch);
            (
                durable.aggregate_id.clone(),
                durable.sequence,
                units(&event.data.title),
            )
        })
        .collect()
}

fn hydrate(client: &mut Client, sub: &str, epoch: &str) {
    let now = client.now();
    for decision in client
        .connection
        .complete_hydration(sub, epoch.into(), now)
        .unwrap()
    {
        match decision {
            Decision::Events(batch) => client.batches.push_back(batch),
            Decision::Resync(resync) => client.resyncs.push(resync),
            other => panic!("unexpected hydration decision: {other:?}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_session_and_telemetry_flows_preserve_a_held_snapshot_and_publication_order() {
    bounded(async {
        let session = "ses_wire_concurrent";
        insert_session(session, "/project", None).await;
        let server = start(
            services(LocalAuth::with_password("secret"), true),
            standard().unwrap(),
        )
        .await;
        let mut client = open(server.address()).await;
        rename(&mut client, session, "before snapshot").await;
        let sub = subscribe(&mut client, session).await;
        client.connection.begin_hydration(&sub).unwrap();
        client.hold = true;
        let read = client
            .send(
                "session.snapshot",
                session_scope(session),
                snapshot_request(session),
            )
            .await;
        let (held, read_ordinal) = client.settle_held(&read).await;
        let held: v5::SessionSnapshotResult = success(held);
        assert_eq!(units(&held.data.session.title), "before snapshot");
        assert_eq!(held.data.watermark.seq, Some(0));
        assert_eq!(units(&held.data.watermark.aggregate_id), session);
        assert_eq!(units(&held.data.source_epoch), client.source_epoch);

        let first = client
            .send(
                "session.rename",
                session_scope(session),
                rename_request(session, "first publication"),
            )
            .await;
        let consent = client
            .send(
                "telemetry.consent.set",
                machine(),
                v5::TelemetryConsentSetRequest {
                    payload: v5::TelemetryConsentInput {
                        enabled: true,
                        notice_version: 1.0,
                    },
                }
                .encode_to_vec(),
            )
            .await;
        let second = client
            .send(
                "session.rename",
                session_scope(session),
                rename_request(session, "second publication"),
            )
            .await;
        assert_eq!(client.connection.stats().pending_requests, 3);
        let (result, first_ordinal) = client.settle_held(&first).await;
        let _: v5::SessionRenameResult = success(result);
        let (result, consent_ordinal) = client.settle_held(&consent).await;
        let consent: v5::TelemetryConsentSetResult = success(result);
        assert!(consent.data.enabled);
        let (result, second_ordinal) = client.settle_held(&second).await;
        let _: v5::SessionRenameResult = success(result);
        until(&mut client, |client| {
            client.connection.stats().hydration_bytes > 0
        })
        .await;
        assert!(client.batches.is_empty(), "publication escaped hydration");
        assert_eq!(units(&held.data.session.title), "before snapshot");
        assert_eq!(held.data.watermark.seq, Some(0));
        client.hold = false;
        for ordinal in [read_ordinal, first_ordinal, consent_ordinal, second_ordinal] {
            client.consume(ordinal);
        }
        hydrate(&mut client, &sub, &units(&held.data.source_epoch));
        until(&mut client, |client| renamed(client, &sub).len() == 2).await;
        assert_eq!(
            renamed(&client, &sub),
            vec![
                (session.into(), 1, "first publication".into()),
                (session.into(), 2, "second publication".into())
            ]
        );
        let latest: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope(session),
                    snapshot_request(session),
                )
                .await,
        );
        assert_eq!(latest.data.watermark.seq, Some(2));
        assert_eq!(units(&latest.data.session.title), "second publication");
        assert!(latest.data.messages.items.is_empty());
        let consent: v5::TelemetryConsentGetResult = success(
            client
                .call("telemetry.consent.get", machine(), Vec::new())
                .await,
        );
        assert!(consent.data.consent.unwrap().enabled);
        assert!(client.events.is_empty(), "a request settled more than once");
        assert!(client.resyncs.is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn colliding_request_ids_on_two_connections_keep_results_and_subscriptions_isolated() {
    bounded(async {
        let sessions = ["ses_wire_peer_a", "ses_wire_peer_b"];
        for session in sessions {
            insert_session(session, "/project", None).await;
        }
        let server = start(
            services(LocalAuth::with_password("secret"), true),
            standard().unwrap(),
        )
        .await;
        let mut owner = open(server.address()).await;
        let mut peer = open(server.address()).await;
        assert_ne!(owner.epoch, peer.epoch);
        let left = owner
            .send(
                "session.snapshot",
                session_scope(sessions[0]),
                snapshot_request(sessions[0]),
            )
            .await;
        let right = peer
            .send(
                "session.snapshot",
                session_scope(sessions[1]),
                snapshot_request(sessions[1]),
            )
            .await;
        assert_eq!(left, right);
        let (left, right) = tokio::join!(owner.settle(&left), peer.settle(&right));
        let left: v5::SessionSnapshotResult = success(left);
        let right: v5::SessionSnapshotResult = success(right);
        assert_eq!(units(&left.data.session.id), sessions[0]);
        assert_eq!(units(&right.data.session.id), sessions[1]);
        let own_sub = subscribe(&mut owner, sessions[0]).await;
        let peer_sub = subscribe(&mut peer, sessions[1]).await;
        assert_ne!(own_sub, peer_sub);
        let denied = rejected(
            peer.call(
                "event.unsubscribe",
                global(),
                v5::EventUnsubscribeRequest {
                    subscription_id: own_sub.clone(),
                }
                .encode_to_vec(),
            )
            .await,
        );
        assert_eq!(denied.type_name, v5::InvalidRequestError::full_name());
        let error = v5::InvalidRequestError::decode(denied.payload.as_slice()).unwrap();
        assert_eq!(units(&error.message), "unknown subscription");
        let left = owner
            .send(
                "session.rename",
                session_scope(sessions[0]),
                rename_request(sessions[0], "owner title"),
            )
            .await;
        let right = peer
            .send(
                "session.rename",
                session_scope(sessions[1]),
                rename_request(sessions[1], "peer title"),
            )
            .await;
        let (left, right) = tokio::join!(owner.settle(&left), peer.settle(&right));
        let _: v5::SessionRenameResult = success(left);
        let _: v5::SessionRenameResult = success(right);
        tokio::join!(
            until(&mut owner, |client| renamed(client, &own_sub).len() == 1),
            until(&mut peer, |client| renamed(client, &peer_sub).len() == 1)
        );
        assert_eq!(
            renamed(&owner, &own_sub),
            vec![(sessions[0].into(), 0, "owner title".into())]
        );
        assert_eq!(
            renamed(&peer, &peer_sub),
            vec![(sessions[1].into(), 0, "peer title".into())]
        );
        assert!(
            owner
                .batches
                .iter()
                .all(|batch| batch.subscription_id == own_sub)
        );
        assert!(
            peer.batches
                .iter()
                .all(|batch| batch.subscription_id == peer_sub)
        );
        assert!(owner.ended.is_empty() && peer.ended.is_empty());
        assert!(owner.events.is_empty() && peer.events.is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_request_id_reuse_closes_only_its_connection_before_second_dispatch() {
    bounded(async {
        let session = "ses_wire_duplicate";
        insert_session(session, "/project", None).await;
        let server = start(
            services(LocalAuth::with_password("secret"), true),
            standard().unwrap(),
        )
        .await;
        let mut owner = open(server.address()).await;
        let mut peer = open(server.address()).await;
        let sub = subscribe(&mut peer, session).await;
        let (started, wait) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let writer = world()
            .store
            .submit(move |_| {
                started.send(()).unwrap();
                gate.blocking_recv().unwrap();
                Ok(())
            })
            .unwrap();
        wait.await.unwrap();
        let request = owner
            .send(
                "session.rename",
                session_scope(session),
                rename_request(session, "first dispatch"),
            )
            .await;
        owner
            .socket
            .send_binary(
                &v5::Frame {
                    revision: 5,
                    connection_epoch: Some(owner.epoch.clone()),
                    ledger: Some(v5::LedgerClass::Normal as i32),
                    delivery_ordinal: Some(2),
                    tiny_consumed_through: None,
                    body: Some(v5::frame::Body::Request(v5::Request {
                        request_id: request,
                        operation_id: operation("session.rename").operation_id,
                        scope: session_scope(session),
                        payload: rename_request(session, "duplicate must not dispatch"),
                    })),
                }
                .encode_to_vec(),
            )
            .await;
        assert_eq!(owner.closed().await.0, 1002);
        release.send(()).unwrap();
        writer.await.unwrap();
        until(&mut peer, |client| renamed(client, &sub).len() == 1).await;
        let result: v5::SessionSnapshotResult = success(
            peer.call(
                "session.snapshot",
                session_scope(session),
                snapshot_request(session),
            )
            .await,
        );
        assert_eq!(units(&result.data.session.title), "first dispatch");
        assert_eq!(result.data.watermark.seq, Some(0));
        assert_eq!(
            renamed(&peer, &sub),
            vec![(session.into(), 0, "first dispatch".into())]
        );
        assert!(peer.close.is_none());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn source_epoch_replacement_resyncs_a_stale_snapshot_without_delivering_stale_events() {
    bounded(async {
        let session = "ses_wire_epoch";
        insert_session(session, "/project", None).await;
        let server = start(
            services(LocalAuth::with_password("secret"), true),
            standard().unwrap(),
        )
        .await;
        let mut previous = open(server.address()).await;
        let _old_sub = subscribe(&mut previous, session).await;
        rename(&mut previous, session, "old source").await;
        let old: v5::SessionSnapshotResult = success(
            previous
                .call(
                    "session.snapshot",
                    session_scope(session),
                    snapshot_request(session),
                )
                .await,
        );
        let old_epoch = previous.epoch.clone();
        server.shutdown().await.unwrap();
        assert_eq!(previous.closed().await.0, 1012);

        let mut replacement = services(LocalAuth::with_password("secret"), true);
        replacement.identity.source_epoch = "replacement-source".into();
        let server = start(replacement, standard().unwrap()).await;
        let mut client = open(server.address()).await;
        assert_ne!(client.epoch, old_epoch);
        assert_ne!(client.source_epoch, units(&old.data.source_epoch));
        let sub = subscribe(&mut client, session).await;
        client.connection.begin_hydration(&sub).unwrap();
        rename(&mut client, session, "new source during stale read").await;
        until(&mut client, |client| {
            client.connection.stats().hydration_bytes > 0
        })
        .await;
        hydrate(&mut client, &sub, &units(&old.data.source_epoch));
        assert!(
            client.batches.is_empty(),
            "mismatched epoch events reached the projection"
        );
        assert_eq!(client.resyncs.len(), 1);
        assert_eq!(client.resyncs[0].scope, session_scope(session));
        assert_eq!(client.resyncs[0].source_epoch, "replacement-source");
        assert_eq!(client.resyncs[0].message_id, None);
        client.connection.begin_hydration(&sub).unwrap();
        let canonical: v5::SessionSnapshotResult = success(
            client
                .call(
                    "session.snapshot",
                    session_scope(session),
                    snapshot_request(session),
                )
                .await,
        );
        hydrate(&mut client, &sub, &units(&canonical.data.source_epoch));
        assert_eq!(
            units(&canonical.data.session.title),
            "new source during stale read"
        );
        assert_eq!(canonical.data.watermark.seq, Some(1));
        assert!(canonical.data.messages.items.is_empty());
        rename(&mut client, session, "fresh after canonical reload").await;
        until(&mut client, |client| renamed(client, &sub).len() == 1).await;
        assert_eq!(
            renamed(&client, &sub),
            vec![(session.into(), 2, "fresh after canonical reload".into())]
        );
        assert_eq!(client.resyncs.len(), 1);
        assert!(client.close.is_none());
        assert!(
            world()
                .core
                .sessions
                .pending_list(&ycoding_core::ycoding_schema::session::Id::new(session).unwrap())
                .unwrap()
                .is_empty()
        );
        assert!(script(session).requests().is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}
