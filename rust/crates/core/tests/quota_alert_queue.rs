use std::sync::{
    Arc, Mutex,
    mpsc::{self, Receiver, Sender},
};
use ycoding_core::resources::model::quota::alert_queue::{CAPACITY, Queue};

struct Blocked {
    queue: Queue<u32>,
    started: Receiver<()>,
    release: Sender<()>,
    handled: Arc<Mutex<Vec<u32>>>,
}

fn blocked() -> Blocked {
    let (started_tx, started) = mpsc::channel();
    let (release, release_rx) = mpsc::channel::<()>();
    let handled = Arc::new(Mutex::new(Vec::new()));
    let seen = handled.clone();
    let release_rx = Mutex::new(release_rx);
    let queue = Queue::spawn(CAPACITY, move |item| {
        started_tx.send(()).unwrap();
        release_rx.lock().unwrap().recv().unwrap();
        seen.lock().unwrap().push(item);
    })
    .unwrap();
    Blocked {
        queue,
        started,
        release,
        handled,
    }
}

#[test]
fn a_full_queue_drops_the_newest_offer_without_blocking() {
    let blocked = blocked();
    assert!(blocked.queue.offer(0));
    blocked.started.recv().unwrap();
    for item in 1..=CAPACITY as u32 {
        assert!(blocked.queue.offer(item), "item {item}");
    }
    assert!(!blocked.queue.offer(CAPACITY as u32 + 1));
    for _ in 0..=CAPACITY {
        blocked.release.send(()).unwrap();
    }
    blocked.queue.flush();
    let handled = blocked.handled.lock().unwrap().clone();
    assert_eq!(handled, (0..=CAPACITY as u32).collect::<Vec<_>>());
}

#[test]
fn a_drained_queue_accepts_offers_again_and_flush_waits_for_handled_items() {
    let blocked = blocked();
    assert!(blocked.queue.offer(1));
    blocked.started.recv().unwrap();
    blocked.release.send(()).unwrap();
    blocked.queue.flush();
    assert_eq!(*blocked.handled.lock().unwrap(), vec![1]);
    assert!(blocked.queue.offer(2));
    blocked.started.recv().unwrap();
    blocked.release.send(()).unwrap();
    blocked.queue.flush();
    assert_eq!(*blocked.handled.lock().unwrap(), vec![1, 2]);
}
