mod support;

use prost::{Message, Name};
use std::{sync::Arc, time::Duration};
use support::*;
use tokio::{sync::Mutex, time::timeout};
use ycoding_protocol::{connection::Outcome, v5};
use ycoding_runtime::{LocalAuth, Subscriptions, standard};

static SERIAL: Mutex<()> = Mutex::const_new(());

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}

async fn open(address: std::net::SocketAddr) -> Client {
    Client::open(address, &[("Authorization", basic("secret"))])
        .await
        .unwrap()
}

async fn subscribe(client: &mut Client, log: bool) -> String {
    let scope = session_scope("ses_prompt");
    if log {
        let request = client
            .send(
                "session.log",
                scope.clone(),
                v5::SessionLogRequest {
                    params: v5::SessionLogRequestParams {
                        session_id: text("ses_prompt"),
                    },
                    query: v5::SessionLogRequestQuery {
                        after: None,
                        follow: Some(true),
                    },
                }
                .encode_to_vec(),
            )
            .await;
        return client.subscribe_log(&request, scope).await;
    }
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

async fn unsubscribe(client: &mut Client, subscription_id: &str) -> Outcome {
    client
        .call(
            "event.unsubscribe",
            global(),
            v5::EventUnsubscribeRequest {
                subscription_id: subscription_id.into(),
            }
            .encode_to_vec(),
        )
        .await
}

async fn admit(client: &mut Client, input: &str) {
    let _: v5::SessionPromptResult = success(
        client
            .call(
                "session.prompt",
                session_scope("ses_prompt"),
                v5::SessionPromptRequest {
                    params: v5::SessionPromptRequestParams {
                        session_id: text("ses_prompt"),
                    },
                    payload: v5::SessionPromptRequestPayload {
                        id: Some(text(input)),
                        text: text("subscription ownership"),
                        files: None,
                        agents: None,
                        metadata: None,
                        delivery: Some(v5::SessionPromptRequestPayloadDelivery::Queue as i32),
                        resume: Some(false),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
}

fn received(client: &Client, sub: &str, input: &str) -> bool {
    client
        .batches
        .iter()
        .filter(|batch| batch.subscription_id == sub)
        .flat_map(|batch| &batch.events)
        .any(|record| {
            if record.event.type_name == v5::PublicEvent::full_name() {
                let item = v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
                return matches!(item.kind, Some(v5::public_event::Kind::SessionInputAdmitted(event)) if units(&event.data.input_id) == input);
            }
            assert_eq!(record.event.type_name, v5::SessionLogItem::full_name());
            let item = v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap();
            matches!(item.kind, Some(v5::session_log_item::Kind::Value15(event)) if units(&event.data.input_id) == input)
        })
}

async fn until(client: &mut Client, done: impl Fn(&Client) -> bool) {
    timeout(Duration::from_secs(10), async {
        while !done(client) {
            assert!(
                client.close.is_none(),
                "connection closed: {:?}",
                client.close
            );
            client.step().await;
        }
    })
    .await
    .expect("stream did not reach its boundary");
}

async fn subscriber_count(expected: usize) {
    timeout(Duration::from_secs(10), async {
        while world().core.events.subscribers() != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("feed subscribers were not released");
}

async fn ownership(log: bool, input: &str) {
    let server = start(
        services(LocalAuth::with_password("secret"), true),
        standard().unwrap(),
    )
    .await;
    let mut owner = open(server.address()).await;
    let mut peer = open(server.address()).await;
    assert_ne!(owner.epoch, peer.epoch);
    let sub = subscribe(&mut owner, log).await;
    let peer_sub = subscribe(&mut peer, log).await;
    assert_ne!(sub, peer_sub);

    let unknown = rejected(unsubscribe(&mut peer, "unknown-subscription").await);
    assert_eq!(unknown.type_name, v5::InvalidRequestError::full_name());
    let error = v5::InvalidRequestError::decode(unknown.payload.as_slice()).unwrap();
    assert_eq!(units(&error.message), "unknown subscription");
    assert_eq!(rejected(unsubscribe(&mut peer, &sub).await), unknown);

    admit(&mut peer, input).await;
    until(&mut owner, |client| received(client, &sub, input)).await;
    until(&mut peer, |client| received(client, &peer_sub, input)).await;
    assert!(owner.ended.is_empty());
    assert!(peer.ended.is_empty());

    let _: v5::EventUnsubscribeResult = success(unsubscribe(&mut owner, &sub).await);
    until(&mut owner, |client| client.ended.contains(&sub)).await;
    assert_eq!(owner.ended, vec![sub.clone()]);
    assert_eq!(rejected(unsubscribe(&mut owner, &sub).await), unknown);
    let after = format!("{input}_after");
    admit(&mut peer, &after).await;
    until(&mut peer, |client| received(client, &peer_sub, &after)).await;
    let _: v5::ServerGetResult = success(owner.call("server.get", machine(), Vec::new()).await);
    assert!(!received(&owner, &sub, &after));
    assert!(peer.ended.is_empty());
    let _: v5::EventUnsubscribeResult = success(unsubscribe(&mut peer, &peer_sub).await);
    until(&mut peer, |client| client.ended.contains(&peer_sub)).await;
    subscriber_count(0).await;
    server.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn event_subscription_is_owned_by_the_authenticated_connection() {
    let _serial = SERIAL.lock().await;
    timeout(Duration::from_secs(60), ownership(false, "msg_sub_event"))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_follow_is_owned_by_the_authenticated_connection() {
    let _serial = SERIAL.lock().await;
    timeout(Duration::from_secs(60), ownership(true, "msg_sub_log"))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_removes_both_stream_entries_and_reconnect_cannot_release_peer_entries() {
    let _serial = SERIAL.lock().await;
    timeout(Duration::from_secs(60), async {
        let removed = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
        let inspect = removed.clone();
        let mut dispatcher = standard().unwrap();
        dispatcher
            .authorize("server.get", move |environment, _| {
                for (owner, sub) in inspect.lock().unwrap().iter() {
                    assert_eq!(
                        environment.subscriptions.ended(owner, sub),
                        None,
                        "leaked {sub}"
                    );
                }
                Ok(())
            })
            .unwrap();
        let server = start(
            services(LocalAuth::with_password("secret"), true),
            dispatcher,
        )
        .await;
        let mut owner = open(server.address()).await;
        let mut peer = open(server.address()).await;
        let old_epoch = owner.epoch.clone();
        let event = subscribe(&mut owner, false).await;
        let log = subscribe(&mut owner, true).await;
        let peer_sub = subscribe(&mut peer, false).await;
        assert_ne!(event, log);
        assert_ne!(event, peer_sub);
        assert_ne!(log, peer_sub);
        subscriber_count(3).await;
        drop(owner);
        subscriber_count(1).await;
        *removed.lock().unwrap() = vec![
            (old_epoch.clone(), event.clone()),
            (old_epoch.clone(), log.clone()),
        ];
        let _: v5::ServerGetResult = success(peer.call("server.get", machine(), Vec::new()).await);
        let mut replacement = open(server.address()).await;
        assert_ne!(old_epoch, replacement.epoch);
        let unknown = rejected(unsubscribe(&mut replacement, "unknown-subscription").await);
        for sub in [&event, &log, &peer_sub] {
            assert_eq!(rejected(unsubscribe(&mut replacement, sub).await), unknown);
        }
        let new_sub = subscribe(&mut replacement, false).await;
        assert_ne!(event, new_sub);
        assert_ne!(log, new_sub);
        assert_ne!(peer_sub, new_sub);
        admit(&mut replacement, "msg_sub_replacement").await;
        until(&mut peer, |client| {
            received(client, &peer_sub, "msg_sub_replacement")
        })
        .await;
        until(&mut replacement, |client| {
            received(client, &new_sub, "msg_sub_replacement")
        })
        .await;
        server.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[test]
fn registry_rejects_foreign_and_repeated_release_and_cleans_only_the_owner() {
    let subscriptions = Subscriptions::default();
    subscriptions.arm("owner", "event".into());
    subscriptions.arm("owner", "log".into());
    subscriptions.arm("peer", "peer-event".into());
    assert!(!subscriptions.end("peer", "event"));
    assert!(!subscriptions.end("owner", "unknown"));
    assert_eq!(subscriptions.ended("owner", "event"), Some(false));
    assert_eq!(subscriptions.ended("peer", "event"), None);
    subscriptions.remove("peer", "event");
    assert_eq!(subscriptions.ended("owner", "event"), Some(false));
    assert!(subscriptions.end("owner", "event"));
    assert!(!subscriptions.end("owner", "event"));
    assert_eq!(subscriptions.ended("owner", "event"), Some(true));
    subscriptions.release("owner");
    assert_eq!(subscriptions.ended("owner", "event"), None);
    assert_eq!(subscriptions.ended("owner", "log"), None);
    assert_eq!(subscriptions.ended("peer", "peer-event"), Some(false));
    subscriptions.remove("peer", "peer-event");
    assert_eq!(subscriptions.ended("peer", "peer-event"), None);
}
