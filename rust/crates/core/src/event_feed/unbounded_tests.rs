use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use ycoding_schema::{DomainDecode, JsonValue, question};

fn feed(retained: usize, capacity: usize) -> (ycoding_store::Store, Feed) {
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::native::catalog(ycoding_store::native::DatabaseKind::Core),
        ycoding_store::Metadata::new([19; 16], 1),
    )
    .unwrap();
    let feed = Feed::attach_with(&store.client(), retained, capacity);
    (store, feed)
}

fn request(index: usize) -> question::Id {
    question::Id::decode(&JsonValue::String(format!("que_{index}").into())).unwrap()
}

fn replied(feed: &Feed, index: usize) {
    feed.emit(
        Data::QuestionReplied(Box::new(question::RepliedData {
            session_id: session::Id::new("ses_synthetic").unwrap(),
            request_id: request(index),
            answers: vec![],
        })),
        None,
    )
    .unwrap();
}

fn rejected(feed: &Feed, index: usize) {
    feed.emit(
        Data::QuestionRejected(Box::new(question::RejectedData {
            session_id: session::Id::new("ses_synthetic").unwrap(),
            request_id: request(index),
        })),
        None,
    )
    .unwrap();
}

fn drained(subscriber: &Subscriber) -> Vec<question::Id> {
    let mut found = Vec::new();
    while let Some(item) = subscriber
        .next()
        .expect("an unbounded subscriber never overflows")
    {
        let Payload::Ephemeral(event) = &item.payload else {
            panic!("only ephemeral replies are subscribed");
        };
        let Data::QuestionReplied(data) = &event.data else {
            panic!("only the subscribed type is queued");
        };
        found.push(data.request_id.clone());
    }
    found
}

#[test]
fn an_unbounded_subscription_delivers_every_matching_item_in_order_past_the_default_capacity() {
    let (_store, feed) = feed(RETAINED_ITEMS, SUBSCRIBER_CAPACITY);
    let wakes = Arc::new(AtomicUsize::new(0));
    let counted = wakes.clone();
    let subscriber = feed
        .subscribe_types_unbounded(Scope::Global, &["question.replied"], move || {
            counted.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
    let total = SUBSCRIBER_CAPACITY + 904;
    for index in 0..total {
        rejected(&feed, index);
        replied(&feed, index);
    }
    assert!(wakes.load(Ordering::SeqCst) >= 1);
    assert_eq!(
        drained(&subscriber),
        (0..total).map(request).collect::<Vec<_>>()
    );
    assert!(subscriber.next().unwrap().is_none());
    assert_eq!(feed.subscribers(), 1);
}

#[test]
fn a_bounded_subscription_still_reports_overflow_and_leaves_the_feed() {
    let (_store, feed) = feed(16, 2);
    let bounded = feed
        .subscribe_types(Scope::Global, &["question.replied"], || {})
        .unwrap();
    let unbounded = feed
        .subscribe_types_unbounded(Scope::Global, &["question.replied"], || {})
        .unwrap();
    for index in 0..3 {
        replied(&feed, index);
    }
    assert_eq!(bounded.next().unwrap_err(), Overflow { capacity: 2 });
    assert_eq!(feed.subscribers(), 1);
    assert_eq!(drained(&unbounded), (0..3).map(request).collect::<Vec<_>>());
}

#[test]
fn the_retained_ring_still_reports_a_gap_for_a_resume_it_no_longer_holds() {
    let (_store, feed) = feed(2, 8);
    for index in 0..5 {
        replied(&feed, index);
    }
    assert!(matches!(
        feed.subscribe(Scope::Global, Some(0), || {}),
        Err(ResumeError::Gap { oldest: 4 })
    ));
    assert!(matches!(
        feed.subscribe(Scope::Global, Some(9), || {}),
        Err(ResumeError::Ahead { latest: 5 })
    ));
}

#[test]
fn dropping_an_unbounded_subscriber_unsubscribes_it() {
    let (_store, feed) = feed(16, 2);
    let subscriber = feed
        .subscribe_types_unbounded(Scope::Global, &["question.replied"], || {})
        .unwrap();
    assert_eq!(feed.subscribers(), 1);
    drop(subscriber);
    assert_eq!(feed.subscribers(), 0);
}
