mod connector_support;
mod support;

use connector_support::{Command, Opening, Relay};
use prost::Message;
use std::{sync::Arc, time::Duration};
use support::{operation, services, session_scope, text, world};
use ycoding_core::{
    event_feed::{Data, Feed, ephemeral::Fragment},
    ycoding_schema::{schema::NonNegativeInt, session, session_message},
};
use ycoding_protocol::{connection::Budgets, decode_strict, v5};
use ycoding_runtime::{
    Environment, LocalAuth, Subscriptions,
    connector::{Connector, Control, Credential, Credentials, Enrolled, Error, Settings, State},
    standard,
};

struct Access(String);

impl Credentials for Access {
    fn enrolled(&self) -> ycoding_runtime::Boxed<Result<Enrolled, Error>> {
        let enrolled = Enrolled::new(&self.0, "device-a".into());
        Box::pin(async move { enrolled })
    }
    fn access(&self) -> ycoding_runtime::Boxed<Result<Credential, Error>> {
        let origin = self.0.clone();
        Box::pin(async move {
            Ok(Credential::new(
                "stand-in-token".into(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as i64
                    + 600_000,
                origin,
                "device-a".into(),
            ))
        })
    }
}

async fn snapshot(opening: &Opening, client: &str, sessions: &[&str]) {
    opening
        .commands
        .send(Command::Body(v5::frame::Body::Control(v5::Control {
            kind: Some(v5::control::Kind::SubscriptionSnapshot(
                v5::SubscriptionSnapshot {
                    client_id: client.into(),
                    session_ids: sessions.iter().map(|session| (*session).into()).collect(),
                },
            )),
        })))
        .await
        .unwrap();
}

async fn subscribe(relay: &mut Relay, opening: &Opening, session: &str) -> String {
    let scope = session_scope(session);
    let id = opening
        .request(
            operation("event.subscribe").operation_id,
            scope.clone(),
            v5::EventSubscribeRequest { scope }.encode_to_vec(),
        )
        .await;
    let frame = relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)).await;
    let Some(v5::frame::Body::Result(v5::Result {
        outcome: Some(v5::result::Outcome::Success(payload)),
        ..
    })) = frame.body
    else {
        panic!("subscription failed");
    };
    let result = decode_strict::<v5::EventSubscribeResult>(&payload.payload).unwrap();
    String::from_utf16(&ycoding_protocol::decode_lossless(&result.subscription_id, 1024).unwrap())
        .unwrap()
}

async fn fence(relay: &mut Relay, opening: &Opening, session: &str) {
    let id = opening
        .request(
            operation("session.todo.list").operation_id,
            session_scope(session),
            v5::SessionTodoListRequest {
                params: v5::SessionTodoListRequestParams {
                    session_id: text(session),
                },
            }
            .encode_to_vec(),
        )
        .await;
    relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)).await;
}

fn emit(feed: &Feed, session: &str, index: i64, length: usize) {
    feed.emit(
        Data::SessionTextDelta(Box::new(Fragment {
            session_id: session::Id::new(session).unwrap(),
            assistant_message_id: session_message::Id::new("msg_events").unwrap(),
            ordinal: NonNegativeInt::new(index).unwrap(),
            delta: format!("{index}:{}", "x".repeat(length)).into(),
        })),
        None,
    )
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshots_share_one_observer_order_bounded_events_and_release_only_the_last_owner() {
    let directory = std::env::temp_dir().join(format!("connector-events-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    support::insert_session("ses_connector_events", directory.to_str().unwrap(), None).await;
    let feed = Feed::attach(&world().store);
    let budgets = Budgets {
        event_window_bytes: 8192,
        event_queue_bytes: 16384,
        event_queue_count: 2,
        ..Budgets::default()
    };
    let mut relay = Relay::start(5, false, budgets.clone()).await;
    let control = Control::open(&directory).await.unwrap();
    let mut services = services(LocalAuth::disabled(), true);
    services.budgets = budgets;
    services.core.as_mut().unwrap().events = feed.clone();
    let environment = Arc::new(Environment {
        services,
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let mut settings = Settings::new(Arc::new(Access(relay.origin())));
    settings.reconnect_initial = Duration::from_secs(60);
    settings.reconnect_max = Duration::from_secs(60);
    let connector = Connector::start(
        control.clone(),
        settings,
        environment,
        Arc::new(standard().unwrap()),
    )
    .unwrap();
    control.set(true).await.unwrap();
    let opening = relay.opening().await;
    relay
        .matching(opening.generation, |frame| {
            matches!(
                &frame.body,
                Some(v5::frame::Body::Control(v5::Control {
                    kind: Some(v5::control::Kind::Ping(_))
                }))
            )
        })
        .await;
    snapshot(&opening, "unknown", &["ses_connector_absent"]).await;
    let scope = session_scope("ses_connector_absent");
    let id = opening
        .request(
            operation("event.subscribe").operation_id,
            scope.clone(),
            v5::EventSubscribeRequest { scope }.encode_to_vec(),
        )
        .await;
    let rejected = relay.matching(opening.generation, |frame| matches!(&frame.body, Some(v5::frame::Body::Result(result)) if result.request_id == id)).await;
    let Some(v5::frame::Body::Result(v5::Result {
        outcome: Some(v5::result::Outcome::Error(error)),
        ..
    })) = rejected.body
    else {
        panic!("unknown Session was accepted");
    };
    assert_eq!(error.type_name, "ycoding.v5.InvalidRequestError");
    let error = decode_strict::<v5::InvalidRequestError>(&error.payload).unwrap();
    assert_eq!(support::units(error.kind.as_ref().unwrap()), "not_found");
    assert_eq!(feed.subscribers(), 2);
    snapshot(&opening, "unknown", &[]).await;
    snapshot(&opening, "first", &["ses_connector_events"]).await;
    let first = subscribe(&mut relay, &opening, "ses_connector_events").await;
    snapshot(&opening, "second", &["ses_connector_events"]).await;
    let second = subscribe(&mut relay, &opening, "ses_connector_events").await;
    assert_eq!(first, second);
    assert_eq!(feed.subscribers(), 3);
    for index in 0..8 {
        emit(&feed, "ses_connector_events", index, 4000);
    }
    let first_frame = relay
        .matching(opening.generation, |frame| {
            matches!(frame.body, Some(v5::frame::Body::EventBatch(_)))
        })
        .await;
    fence(&mut relay, &opening, "ses_connector_events").await;
    let mut frame = first_frame;
    let mut received = Vec::new();
    loop {
        let Some(v5::frame::Body::EventBatch(batch)) = &frame.body else {
            panic!("event batch");
        };
        assert_eq!(batch.subscription_id, first);
        assert_eq!(batch.source_epoch, "source-epoch-test");
        for event in &batch.events {
            let public = decode_strict::<v5::PublicEvent>(&event.event.payload).unwrap();
            let Some(v5::public_event::Kind::SessionTextDelta(delta)) = public.kind else {
                panic!("text delta");
            };
            received.push(delta.data.ordinal);
        }
        opening
            .commands
            .send(Command::ConsumeEvent(frame.delivery_ordinal.unwrap()))
            .await
            .unwrap();
        if received.len() == 8 {
            break;
        }
        frame = relay
            .matching(opening.generation, |frame| {
                matches!(frame.body, Some(v5::frame::Body::EventBatch(_)))
            })
            .await;
    }
    assert_eq!(received, (0..8).collect::<Vec<_>>());
    snapshot(&opening, "first", &[]).await;
    fence(&mut relay, &opening, "ses_connector_events").await;
    assert_eq!(feed.subscribers(), 3);
    emit(&feed, "ses_connector_events", 8, 0);
    let frame = relay
        .matching(opening.generation, |frame| {
            matches!(frame.body, Some(v5::frame::Body::EventBatch(_)))
        })
        .await;
    opening
        .commands
        .send(Command::ConsumeEvent(frame.delivery_ordinal.unwrap()))
        .await
        .unwrap();
    snapshot(&opening, "second", &[]).await;
    fence(&mut relay, &opening, "ses_connector_events").await;
    assert_eq!(feed.subscribers(), 2);
    assert_eq!(control.status().state, State::On);
    connector.shutdown().await.unwrap();
    assert_eq!(feed.subscribers(), 0);
    relay.shutdown().await;
}
