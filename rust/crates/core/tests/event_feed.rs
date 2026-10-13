use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
};
use ycoding_core::{
    event_feed::{Ephemeral, Feed, Item, Overflow, Payload, ResumeError, Scope, Subscriber},
    session::store::Service,
};
use ycoding_schema::{DomainDecode, parse_json, session};
use ycoding_store::{
    Client, Error,
    session::{self as tables, NewEvent},
};

#[path = "autonomy_support/mod.rs"]
mod support;

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn pinned(session: &str, event: &str, kind: &str) -> NewEvent {
    NewEvent {
        id: event.into(),
        aggregate_id: session.into(),
        created: 5,
        type_: kind.into(),
        data: parse_json(&format!(r#"{{"sessionID":"{session}"}}"#)).unwrap(),
    }
}

fn ephemeral(event: &str, session: Option<&str>) -> Ephemeral {
    Ephemeral {
        id: event.into(),
        created: 7,
        session: session.map(id),
        metadata: None,
        location: None,
        data: ycoding_core::event_feed::Data::ConfigUpdated(Box::new(
            ycoding_schema::config::Empty,
        )),
    }
}

fn drain(subscriber: &Subscriber) -> Vec<Arc<Item>> {
    std::iter::from_fn(|| subscriber.next().unwrap()).collect()
}

fn positions(items: &[Arc<Item>]) -> Vec<u64> {
    items.iter().map(|item| item.position).collect()
}

fn durable(item: &Item) -> (String, i64, String) {
    let Payload::Durable(event) = &item.payload else {
        panic!("expected a durable event, got {item:?}");
    };
    (
        event.aggregate_id.to_utf8().unwrap(),
        event.seq,
        event.type_.to_utf8().unwrap(),
    )
}

fn ephemeral_id(item: &Item) -> String {
    let Payload::Ephemeral(event) = &item.payload else {
        panic!("expected an ephemeral event, got {item:?}");
    };
    event.id.to_utf8().unwrap()
}

fn live(feed: &Feed, scope: Scope) -> Subscriber {
    feed.subscribe(scope, None, || {}).unwrap()
}

fn append_in_one_transaction(client: &Client, events: Vec<NewEvent>) {
    client
        .submit(move |tx| {
            for event in &events {
                tables::append(tx, event, None)?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

#[test]
fn event_source_retains_one_feed_and_location_and_rejects_reassignment() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    let source = ycoding_core::event_feed::EventSource::default();
    let location = ycoding_schema::location::Ref::decode(
        &parse_json(r#"{"directory":"/project","workspaceID":"wrk_one"}"#).unwrap(),
    )
    .unwrap();
    let subscriber = live(&feed, Scope::Global);
    source.bind(feed.clone(), Some(location.clone())).unwrap();
    source.bind(feed.clone(), Some(location.clone())).unwrap();
    assert!(
        source
            .bind(Feed::attach(&store.client()), Some(location.clone()))
            .is_err()
    );
    assert!(source.bind(feed, None).is_err());
    source
        .emit(ycoding_core::event_feed::Data::ConfigUpdated(Box::new(
            ycoding_schema::config::Empty,
        )))
        .unwrap();
    let items = drain(&subscriber);
    assert_eq!(items.len(), 1);
    let Payload::Ephemeral(event) = &items[0].payload else {
        panic!("source emits an ephemeral");
    };
    assert_eq!(event.location, Some(location));
    assert!(event.session.is_none());
}

#[tokio::test]
async fn committed_events_arrive_after_commit_in_commit_order_across_sessions() {
    let store = support::store();
    let sessions = Service::new(store.client());
    let feed = Feed::attach(&store.client());
    let subscriber = live(&feed, Scope::Global);

    for (session, event, kind) in [
        ("ses_one", "evt_a", "session.pinned.1"),
        ("ses_two", "evt_b", "session.pinned.1"),
        ("ses_one", "evt_c", "session.unpinned.1"),
    ] {
        sessions
            .publish(pinned(session, event, kind))
            .await
            .unwrap();
    }

    let items = drain(&subscriber);
    assert_eq!(positions(&items), [1, 2, 3]);
    assert_eq!(
        items.iter().map(|item| durable(item)).collect::<Vec<_>>(),
        [
            ("ses_one".into(), 0, "session.pinned.1".into()),
            ("ses_two".into(), 0, "session.pinned.1".into()),
            ("ses_one".into(), 1, "session.unpinned.1".into()),
        ]
    );
    assert_eq!(feed.watermark(), 3);
}

#[tokio::test]
async fn an_event_is_visible_in_the_store_before_the_feed_announces_it() {
    let store = support::store();
    let sessions = Service::new(store.client());
    let feed = Feed::attach(&store.client());
    let seen = Arc::new(AtomicUsize::new(0));
    let watcher = {
        let (client, seen) = (store.client(), seen.clone());
        feed.subscribe(Scope::Global, None, move || {
            let page = Service::new(client.clone()).log(&id("ses_one"), None, 10);
            seen.store(page.unwrap().events.len(), Ordering::SeqCst);
        })
        .unwrap()
    };

    sessions
        .publish(pinned("ses_one", "evt_a", "session.pinned.1"))
        .await
        .unwrap();

    assert_eq!(seen.load(Ordering::SeqCst), 1);
    assert_eq!(drain(&watcher).len(), 1);
}

#[test]
fn one_transaction_publishes_its_events_contiguously_in_append_order() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    let subscriber = live(&feed, Scope::Global);

    append_in_one_transaction(
        &store.client(),
        vec![
            pinned("ses_one", "evt_a", "session.pinned.1"),
            pinned("ses_two", "evt_b", "session.pinned.1"),
            pinned("ses_one", "evt_c", "session.unpinned.1"),
        ],
    );

    let items = drain(&subscriber);
    assert_eq!(positions(&items), [1, 2, 3]);
    assert_eq!(
        items.iter().map(|item| durable(item).1).collect::<Vec<_>>(),
        [0, 0, 1]
    );
}

#[test]
fn rolled_back_transactions_publish_nothing() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    let subscriber = live(&feed, Scope::Global);

    let failed = store
        .client()
        .submit(|tx| {
            tables::append(tx, &pinned("ses_one", "evt_a", "session.pinned.1"), None)?;
            Err::<(), _>(Error::Rejected("rolled back"))
        })
        .unwrap()
        .wait();
    assert!(failed.is_err());
    assert!(drain(&subscriber).is_empty());
    assert_eq!(feed.watermark(), 0);

    append_in_one_transaction(
        &store.client(),
        vec![pinned("ses_one", "evt_b", "session.pinned.1")],
    );
    let items = drain(&subscriber);
    assert_eq!(positions(&items), [1]);
    assert_eq!(durable(&items[0]).1, 0);
}

#[test]
fn session_scope_selects_that_sessions_durable_and_ephemeral_events_only() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    let one = live(&feed, Scope::Session(id("ses_one")));
    let global = live(&feed, Scope::Global);

    append_in_one_transaction(
        &store.client(),
        vec![
            pinned("ses_one", "evt_a", "session.pinned.1"),
            pinned("ses_two", "evt_b", "session.pinned.1"),
        ],
    );
    feed.publish(ephemeral("eph_one", Some("ses_one")));
    feed.publish(ephemeral("eph_two", Some("ses_two")));
    feed.publish(ephemeral("eph_none", None));

    let scoped = drain(&one);
    assert_eq!(positions(&scoped), [1, 3]);
    assert_eq!(durable(&scoped[0]).0, "ses_one");
    assert_eq!(ephemeral_id(&scoped[1]), "eph_one");
    assert_eq!(positions(&drain(&global)), [1, 2, 3, 4, 5]);
}

#[test]
fn durable_and_ephemeral_events_share_one_total_order() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    let subscriber = live(&feed, Scope::Global);

    append_in_one_transaction(
        &store.client(),
        vec![pinned("ses_one", "evt_a", "session.pinned.1")],
    );
    feed.publish(ephemeral("eph_a", Some("ses_one")));
    append_in_one_transaction(
        &store.client(),
        vec![pinned("ses_one", "evt_b", "session.unpinned.1")],
    );

    let items = drain(&subscriber);
    assert_eq!(positions(&items), [1, 2, 3]);
    assert!(matches!(items[0].payload, Payload::Durable(_)));
    assert_eq!(ephemeral_id(&items[1]), "eph_a");
    assert!(matches!(items[2].payload, Payload::Durable(_)));
}

#[test]
fn resume_from_a_watermark_replays_the_missed_events_and_continues_live() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    feed.publish(ephemeral("eph_1", None));
    feed.publish(ephemeral("eph_2", None));
    let watermark = feed.watermark();
    feed.publish(ephemeral("eph_3", None));
    feed.publish(ephemeral("eph_4", Some("ses_two")));

    let resumed = feed
        .subscribe(Scope::Global, Some(watermark), || {})
        .unwrap();
    feed.publish(ephemeral("eph_5", None));

    let items = drain(&resumed);
    assert_eq!(positions(&items), [3, 4, 5]);
    assert_eq!(
        items
            .iter()
            .map(|item| ephemeral_id(item))
            .collect::<Vec<_>>(),
        ["eph_3", "eph_4", "eph_5"]
    );
    assert!(drain(&resumed).is_empty());

    let at_head = feed
        .subscribe(Scope::Global, Some(feed.watermark()), || {})
        .unwrap();
    assert!(drain(&at_head).is_empty());
}

#[test]
fn resume_replay_respects_the_requested_scope() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    feed.publish(ephemeral("eph_1", Some("ses_one")));
    feed.publish(ephemeral("eph_2", Some("ses_two")));
    feed.publish(ephemeral("eph_3", Some("ses_one")));

    let resumed = feed
        .subscribe(Scope::Session(id("ses_one")), Some(0), || {})
        .unwrap();

    assert_eq!(positions(&drain(&resumed)), [1, 3]);
}

#[test]
fn resume_while_events_are_being_published_has_no_gap_and_no_duplicate() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    feed.publish(ephemeral("eph_0", None));
    let watermark = feed.watermark();
    let publisher = {
        let feed = feed.clone();
        thread::spawn(move || {
            for index in 0..500 {
                feed.publish(ephemeral(&format!("eph_{index}"), None));
            }
        })
    };

    let resumed = feed
        .subscribe(Scope::Global, Some(watermark), || {})
        .unwrap();
    publisher.join().unwrap();

    let received = positions(&drain(&resumed));
    assert_eq!(received, (watermark + 1..=501).collect::<Vec<_>>());
}

#[test]
fn resume_reports_a_gap_when_the_cursor_fell_out_of_retention() {
    let store = support::store();
    let feed = Feed::attach_with(&store.client(), 2, 16);
    for index in 0..5 {
        feed.publish(ephemeral(&format!("eph_{index}"), None));
    }

    assert!(matches!(
        feed.subscribe(Scope::Global, Some(2), || {}),
        Err(ResumeError::Gap { oldest: 4 })
    ));
    let retained = feed.subscribe(Scope::Global, Some(3), || {}).unwrap();
    assert_eq!(positions(&drain(&retained)), [4, 5]);
}

#[test]
fn resume_reports_a_cursor_from_the_future() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    feed.publish(ephemeral("eph_1", None));

    assert!(matches!(
        feed.subscribe(Scope::Global, Some(9), || {}),
        Err(ResumeError::Ahead { latest: 1 })
    ));
}

#[test]
fn a_replay_larger_than_the_subscriber_capacity_is_a_gap() {
    let store = support::store();
    let feed = Feed::attach_with(&store.client(), 16, 2);
    for index in 0..5 {
        feed.publish(ephemeral(&format!("eph_{index}"), None));
    }

    assert!(matches!(
        feed.subscribe(Scope::Global, Some(0), || {}),
        Err(ResumeError::Gap { .. })
    ));
}

#[test]
fn a_slow_subscriber_overflows_without_blocking_publishers_or_other_subscribers() {
    let store = support::store();
    let feed = Feed::attach_with(&store.client(), 16, 2);
    let slow = live(&feed, Scope::Global);
    let fast = live(&feed, Scope::Global);
    let mut received = Vec::new();

    for index in 0..5 {
        feed.publish(ephemeral(&format!("eph_{index}"), None));
        received.extend(positions(&drain(&fast)));
    }

    assert_eq!(received, [1, 2, 3, 4, 5]);
    assert_eq!(slow.next().unwrap_err(), Overflow { capacity: 2 });
    assert_eq!(slow.next().unwrap_err(), Overflow { capacity: 2 });
    assert_eq!(feed.subscribers(), 1);
}

#[test]
fn dropping_a_subscriber_releases_it_and_later_events_are_not_retained_for_it() {
    let store = support::store();
    let feed = Feed::attach(&store.client());
    let subscriber = live(&feed, Scope::Global);
    assert_eq!(feed.subscribers(), 1);

    drop(subscriber);

    assert_eq!(feed.subscribers(), 0);
    feed.publish(ephemeral("eph_1", None));
    assert_eq!(feed.watermark(), 1);
}

#[test]
fn the_wake_callback_fires_once_per_matching_event_and_on_overflow() {
    let store = support::store();
    let feed = Feed::attach_with(&store.client(), 16, 1);
    let wakes = Arc::new(AtomicUsize::new(0));
    let counter = wakes.clone();
    let subscriber = feed
        .subscribe(Scope::Session(id("ses_one")), None, move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();

    feed.publish(ephemeral("eph_other", Some("ses_two")));
    assert_eq!(wakes.load(Ordering::SeqCst), 0);
    feed.publish(ephemeral("eph_1", Some("ses_one")));
    assert_eq!(wakes.load(Ordering::SeqCst), 1);
    feed.publish(ephemeral("eph_2", Some("ses_one")));
    assert_eq!(wakes.load(Ordering::SeqCst), 2);
    assert_eq!(subscriber.next().unwrap_err(), Overflow { capacity: 1 });
}

#[tokio::test]
async fn commits_keep_working_after_the_feed_is_dropped() {
    let store = support::store();
    let sessions = Service::new(store.client());
    drop(Feed::attach(&store.client()));

    sessions
        .publish(pinned("ses_one", "evt_a", "session.pinned.1"))
        .await
        .unwrap();
    let feed = Feed::attach(&store.client());
    let subscriber = live(&feed, Scope::Global);
    sessions
        .publish(pinned("ses_one", "evt_b", "session.unpinned.1"))
        .await
        .unwrap();

    let items = drain(&subscriber);
    assert_eq!(positions(&items), [1]);
    assert_eq!(durable(&items[0]).1, 1);
}
