mod support;

use prost::{Message, Name};
use std::time::{Duration, Instant};
use support::*;
use tokio::{
    sync::Mutex,
    time::{sleep, timeout},
};
use ycoding_protocol::v5;
use ycoding_runtime::{LocalAuth, standard};

static SERIAL: Mutex<()> = Mutex::const_new(());

async fn bounded<F: std::future::Future>(future: F) -> F::Output {
    timeout(Duration::from_secs(60), future)
        .await
        .expect("test exceeded its time bound")
}

fn global() -> v5::Scope {
    v5::Scope {
        target: Some(v5::scope::Target::Global(v5::Empty {})),
    }
}

fn subscribe_request(scope: v5::Scope) -> Vec<u8> {
    v5::EventSubscribeRequest { scope }.encode_to_vec()
}

fn prompt_request(session: &str, id: &str) -> Vec<u8> {
    v5::SessionPromptRequest {
        params: v5::SessionPromptRequestParams {
            session_id: text(session),
        },
        payload: v5::SessionPromptRequestPayload {
            id: Some(text(id)),
            text: text("event probe"),
            files: None,
            agents: None,
            metadata: None,
            delivery: Some(v5::SessionPromptRequestPayloadDelivery::Queue as i32),
            resume: Some(false),
        },
    }
    .encode_to_vec()
}

fn log_request(session: &str, after: Option<u64>, follow: Option<bool>) -> Vec<u8> {
    v5::SessionLogRequest {
        params: v5::SessionLogRequestParams {
            session_id: text(session),
        },
        query: v5::SessionLogRequestQuery { after, follow },
    }
    .encode_to_vec()
}

async fn admit(client: &mut Client, session: &str, id: &str) {
    let _: v5::SessionPromptResult = success(
        client
            .call(
                "session.prompt",
                session_scope(session),
                prompt_request(session, id),
            )
            .await,
    );
}

struct Seen {
    aggregate: String,
    sequence: u64,
    input: String,
}

fn seen(client: &Client, prefix: &str) -> Vec<Seen> {
    client
        .batches
        .iter()
        .flat_map(|batch| batch.events.iter())
        .filter_map(|record| {
            let admitted = match record.event.type_name.as_str() {
                name if name == v5::PublicEvent::full_name() => {
                    let item = v5::PublicEvent::decode(record.event.payload.as_slice()).unwrap();
                    let Some(v5::public_event::Kind::SessionInputAdmitted(admitted)) = item.kind
                    else {
                        return None;
                    };
                    admitted
                }
                name if name == v5::SessionLogItem::full_name() => {
                    let item = v5::SessionLogItem::decode(record.event.payload.as_slice()).unwrap();
                    let Some(v5::session_log_item::Kind::Value15(admitted)) = item.kind else {
                        return None;
                    };
                    admitted
                }
                name => panic!("unexpected subscribed payload {name}"),
            };
            let input = units(&admitted.data.input_id);
            let durable = record.durable.as_ref().unwrap();
            input.starts_with(prefix).then(|| Seen {
                aggregate: durable.aggregate_id.clone(),
                sequence: durable.sequence,
                input,
            })
        })
        .collect()
}

async fn until(client: &mut Client, mut done: impl FnMut(&Client) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done(client) {
        assert!(Instant::now() < deadline, "condition not reached in time");
        client.run_for(Duration::from_millis(50)).await;
    }
}

async fn subscribers_settle_at(expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while world().core.events.subscribers() != expected {
        assert!(
            Instant::now() < deadline,
            "expected {expected} feed subscribers, found {}",
            world().core.events.subscribers()
        );
        sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn global_subscription_streams_committed_events_across_sessions_in_commit_order() {
    let _serial = SERIAL.lock().await;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let id = client
            .send("event.subscribe", global(), subscribe_request(global()))
            .await;
        let sub = client.subscribe_events(&id, global()).await;
        assert!(!sub.is_empty());

        let order = [
            ("ses_prompt", "msg_ev_order_1"),
            ("ses_retry", "msg_ev_order_2"),
            ("ses_prompt", "msg_ev_order_3"),
            ("ses_retry", "msg_ev_order_4"),
        ];
        for (session, input) in order {
            admit(&mut client, session, input).await;
        }
        until(&mut client, |client| {
            seen(client, "msg_ev_order_").len() == 4
        })
        .await;

        let received = seen(&client, "msg_ev_order_");
        assert_eq!(
            received
                .iter()
                .map(|event| (event.aggregate.as_str(), event.input.as_str()))
                .collect::<Vec<_>>(),
            order
        );
        let per_session = |session: &str| {
            received
                .iter()
                .filter(|event| event.aggregate == session)
                .map(|event| event.sequence)
                .collect::<Vec<_>>()
        };
        for session in ["ses_prompt", "ses_retry"] {
            let sequences = per_session(session);
            assert_eq!(sequences.len(), 2);
            assert!(sequences[0] < sequences[1], "{session}: {sequences:?}");
        }
        assert!(client.close.is_none());
        assert!(client.resyncs.is_empty());
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_subscription_receives_only_its_session() {
    let _serial = SERIAL.lock().await;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let scope = session_scope("ses_conflict_a");
        let id = client
            .send(
                "event.subscribe",
                global(),
                subscribe_request(scope.clone()),
            )
            .await;
        client.subscribe_events(&id, scope).await;

        admit(&mut client, "ses_conflict_b", "msg_ev_scope_other").await;
        admit(&mut client, "ses_conflict_a", "msg_ev_scope_mine").await;
        until(&mut client, |client| {
            seen(client, "msg_ev_scope_").len() == 1
        })
        .await;
        client.run_for(Duration::from_millis(300)).await;

        let received = seen(&client, "msg_ev_scope_");
        assert_eq!(received.len(), 1);
        assert_eq!(received[0].aggregate, "ses_conflict_a");
        assert_eq!(received[0].input, "msg_ev_scope_mine");
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_or_unknown_targets_are_rejected_before_a_subscription_exists() {
    let _serial = SERIAL.lock().await;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        for target in [
            machine(),
            v5::Scope {
                target: Some(v5::scope::Target::Workspace("wrk_one".into())),
            },
            session_scope("ses_does_not_exist"),
        ] {
            let payload = rejected(
                client
                    .call("event.subscribe", global(), subscribe_request(target))
                    .await,
            );
            let error = v5::InvalidRequestError::decode(payload.payload.as_slice()).unwrap();
            assert!(!units(&error.message).is_empty());
        }
        assert_eq!(world().core.events.subscribers(), 0);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsubscribe_ends_the_stream_and_releases_the_feed_subscriber() {
    let _serial = SERIAL.lock().await;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let id = client
            .send("event.subscribe", global(), subscribe_request(global()))
            .await;
        let sub = client.subscribe_events(&id, global()).await;
        admit(&mut client, "ses_auto", "msg_ev_unsub_1").await;
        until(&mut client, |client| {
            seen(client, "msg_ev_unsub_").len() == 1
        })
        .await;
        assert_eq!(world().core.events.subscribers(), 1);

        let _: v5::EventUnsubscribeResult = success(
            client
                .call(
                    "event.unsubscribe",
                    global(),
                    v5::EventUnsubscribeRequest {
                        subscription_id: sub.clone(),
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        until(&mut client, |client| client.ended == vec![sub.clone()]).await;
        subscribers_settle_at(0).await;

        admit(&mut client, "ses_auto", "msg_ev_unsub_2").await;
        client.run_for(Duration::from_millis(300)).await;
        assert_eq!(seen(&client, "msg_ev_unsub_").len(), 1);
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_releases_the_feed_subscriber_and_a_reconnect_resumes_from_the_durable_cursor() {
    let _serial = SERIAL.lock().await;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let id = client
            .send("event.subscribe", global(), subscribe_request(global()))
            .await;
        client.subscribe_events(&id, global()).await;
        subscribers_settle_at(1).await;
        admit(&mut client, "ses_interrupt", "msg_ev_resume_1").await;
        until(&mut client, |client| {
            seen(client, "msg_ev_resume_").len() == 1
        })
        .await;
        let cursor = seen(&client, "msg_ev_resume_")[0].sequence;

        drop(client);
        subscribers_settle_at(0).await;

        let mut other = Client::open(server.address(), &[]).await.unwrap();
        admit(&mut other, "ses_interrupt", "msg_ev_resume_2").await;
        let id = other
            .send(
                "event.subscribe",
                global(),
                subscribe_request(session_scope("ses_interrupt")),
            )
            .await;
        other
            .subscribe_events(&id, session_scope("ses_interrupt"))
            .await;
        let log = other
            .send(
                "session.log",
                session_scope("ses_interrupt"),
                log_request("ses_interrupt", Some(cursor), Some(true)),
            )
            .await;
        other
            .subscribe_log(&log, session_scope("ses_interrupt"))
            .await;
        admit(&mut other, "ses_interrupt", "msg_ev_resume_3").await;
        until(&mut other, |client| {
            seen(client, "msg_ev_resume_")
                .iter()
                .filter(|event| event.input == "msg_ev_resume_3")
                .count()
                >= 2
        })
        .await;

        let replayed = seen(&other, "msg_ev_resume_");
        let count = |input: &str| replayed.iter().filter(|event| event.input == input).count();
        assert_eq!(count("msg_ev_resume_1"), 0, "events at or below the cursor");
        assert_eq!(
            count("msg_ev_resume_2"),
            1,
            "gap-free replay after the cursor"
        );
        assert_eq!(
            count("msg_ev_resume_3"),
            2,
            "once per stream, never duplicated"
        );
        server.shutdown().await.unwrap();
    })
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn log_follow_is_driven_by_the_feed_and_releases_it_on_disconnect() {
    let _serial = SERIAL.lock().await;
    bounded(async {
        let server = start(services(LocalAuth::disabled(), true), standard().unwrap()).await;
        let mut client = Client::open(server.address(), &[]).await.unwrap();
        let log = client
            .send(
                "session.log",
                session_scope("ses_files"),
                log_request("ses_files", None, Some(true)),
            )
            .await;
        client.subscribe_log(&log, session_scope("ses_files")).await;
        subscribers_settle_at(1).await;

        admit(&mut client, "ses_files", "msg_ev_follow_1").await;
        until(&mut client, |client| {
            seen(client, "msg_ev_follow_").len() == 1
        })
        .await;

        drop(client);
        subscribers_settle_at(0).await;
        server.shutdown().await.unwrap();
    })
    .await;
}
