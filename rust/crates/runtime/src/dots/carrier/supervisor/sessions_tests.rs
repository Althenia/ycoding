use super::{
    ALREADY_ATTACHED, Borrowed, DETACHED_TTL_MS, Diagnostics, INTERNAL_ERROR, INVALID_REQUEST,
    Link, Opener, Peer, Rejection, Resources, Sessions,
};
use crate::dots::carrier::{
    Clock,
    test_support::{self, TestClock},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::mpsc;
use ycoding_core::ycoding_schema::LosslessString;

struct Fake {
    id: String,
    client_name: Mutex<Option<LosslessString>>,
    fail_initialize: bool,
    lone_unit: bool,
    fail_close: bool,
    closed: Arc<AtomicUsize>,
    link: Mutex<Option<Link>>,
}

impl Resources for Fake {
    fn initialize<'a>(
        &'a self,
        name: &'a LosslessString,
        link: Link,
    ) -> Borrowed<'a, Result<String, Rejection>> {
        Box::pin(async move {
            if self.fail_initialize {
                if self.lone_unit {
                    return Err(Rejection::new(
                        INTERNAL_ERROR,
                        LosslessString::from_utf16(vec![0x62, 0xd800]),
                    ));
                }
                return Err(Rejection::new(INTERNAL_ERROR, "initialize refused"));
            }
            *self.client_name.lock().unwrap() = Some(name.clone());
            *self.link.lock().unwrap() = Some(link);
            Ok(self.id.clone())
        })
    }

    fn close(&self) -> Borrowed<'_, Result<(), ()>> {
        Box::pin(async move {
            self.closed.fetch_add(1, Ordering::SeqCst);
            if self.fail_close { Err(()) } else { Ok(()) }
        })
    }
}

#[derive(Clone, Copy)]
struct Knobs {
    id: &'static str,
    fail_initialize: bool,
    lone_unit: bool,
    fail_close: bool,
}

impl Default for Knobs {
    fn default() -> Self {
        Self {
            id: "session-1",
            fail_initialize: false,
            lone_unit: false,
            fail_close: false,
        }
    }
}

struct Fixture {
    registry: Arc<Sessions>,
    clock: TestClock,
    armed: mpsc::UnboundedReceiver<u64>,
    closed: Arc<AtomicUsize>,
    lines: Arc<Mutex<Vec<String>>>,
    created: Arc<Mutex<Vec<Arc<dyn Resources>>>>,
}

impl Fixture {
    fn new() -> Self {
        let (clock, armed) = test_support::clock();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let diagnostics = Diagnostics::new(Arc::new(move |line| {
            sink.lock().unwrap().push(line.to_owned())
        }));
        let shared: Arc<dyn Clock> = Arc::new(clock.clone());
        Self {
            registry: Sessions::new(shared, DETACHED_TTL_MS, diagnostics),
            clock,
            armed,
            closed: Arc::new(AtomicUsize::new(0)),
            lines,
            created: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn opener(&self, knobs: Knobs) -> Opener {
        let (closed, created) = (self.closed.clone(), self.created.clone());
        Arc::new(move || {
            let fake: Arc<dyn Resources> = Arc::new(Fake {
                id: knobs.id.to_owned(),
                client_name: Mutex::new(None),
                fail_initialize: knobs.fail_initialize,
                lone_unit: knobs.lone_unit,
                fail_close: knobs.fail_close,
                closed: closed.clone(),
                link: Mutex::new(None),
            });
            created.lock().unwrap().push(fake.clone());
            Box::pin(async move { Ok(fake) })
        })
    }

    async fn armed(&mut self) -> u64 {
        tokio::time::timeout(Duration::from_secs(5), self.armed.recv())
            .await
            .expect("no timer armed")
            .unwrap()
    }

    fn closes(&self) -> usize {
        self.closed.load(Ordering::SeqCst)
    }

    async fn closes_reach(&self, count: usize) {
        for _ in 0..500 {
            if self.closes() == count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("closes stayed at {} instead of {count}", self.closes());
    }

    fn link(&self, index: usize) -> Link {
        let created = self.created.lock().unwrap();
        let fake = created[index].downcast_ref::<Fake>().unwrap();
        fake.link.lock().unwrap().clone().unwrap()
    }
}

fn client() -> LosslessString {
    LosslessString::from("client")
}

fn peer(name: &'static str) -> Peer {
    Arc::new(name)
}

fn peer_name(link: &Link) -> Option<&'static str> {
    link.peer()
        .and_then(|peer| peer.downcast_ref::<&'static str>().copied())
}

#[tokio::test]
async fn a_detached_session_resumes_on_another_connection_with_the_same_resources() {
    let f = Fixture::new();
    let open = f.opener(Knobs::default());
    let first = f.registry.connect(open.clone());
    assert_eq!(
        first.initialize(&client(), peer("a")).await.unwrap(),
        "session-1"
    );
    let resources = first.attached().unwrap();
    assert_eq!(peer_name(&f.link(0)), Some("a"));
    first.detach();
    assert_eq!(first.attached().err().unwrap().code, INVALID_REQUEST);
    assert_eq!(peer_name(&f.link(0)), None);
    let second = f.registry.connect(open);
    assert_eq!(
        second.resume("session-1", peer("b")).await.unwrap(),
        "session-1"
    );
    assert!(Arc::ptr_eq(&second.attached().unwrap(), &resources));
    assert_eq!(peer_name(&f.link(0)), Some("b"));
    assert_eq!(f.created.lock().unwrap().len(), 1);
    assert_eq!(f.closes(), 0);
}

#[tokio::test]
async fn resume_rejects_an_attached_or_unknown_session() {
    let f = Fixture::new();
    let open = f.opener(Knobs::default());
    let first = f.registry.connect(open.clone());
    first.initialize(&client(), peer("a")).await.unwrap();
    let second = f.registry.connect(open);
    let attached = second.resume("session-1", peer("b")).await.unwrap_err();
    assert_eq!(attached.code, ALREADY_ATTACHED);
    assert_eq!(second.attached().err().unwrap().code, INVALID_REQUEST);
    assert_eq!(peer_name(&f.link(0)), Some("a"));
    let unknown = second.resume("session-9", peer("b")).await.unwrap_err();
    assert_eq!(
        unknown,
        Rejection::new(INVALID_REQUEST, "unknown session id session-9")
    );
}

#[tokio::test]
async fn a_session_detached_past_its_ttl_is_retired_and_cannot_resume() {
    let mut f = Fixture::new();
    let open = f.opener(Knobs::default());
    let first = f.registry.connect(open.clone());
    first.initialize(&client(), peer("a")).await.unwrap();
    first.detach();
    assert_eq!(f.armed().await, DETACHED_TTL_MS);
    assert_eq!(f.closes(), 0);
    f.clock.advance_to(DETACHED_TTL_MS);
    f.closes_reach(1).await;
    assert!(*f.link(0).retired().borrow());
    let second = f.registry.connect(open);
    let error = second.resume("session-1", peer("b")).await.unwrap_err();
    assert_eq!(error.code, INVALID_REQUEST);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.closes(), 1);
}

#[tokio::test]
async fn resume_at_the_expiry_instant_closes_the_session_exactly_once() {
    let mut f = Fixture::new();
    let open = f.opener(Knobs::default());
    let first = f.registry.connect(open.clone());
    first.initialize(&client(), peer("a")).await.unwrap();
    first.detach();
    f.armed().await;
    f.clock.advance_to(DETACHED_TTL_MS);
    let second = f.registry.connect(open);
    let error = second.resume("session-1", peer("b")).await.unwrap_err();
    assert_eq!(error.code, INVALID_REQUEST);
    f.closes_reach(1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(f.closes(), 1);
}

#[tokio::test]
async fn resuming_inside_the_ttl_cancels_the_retirement() {
    let mut f = Fixture::new();
    let open = f.opener(Knobs::default());
    let first = f.registry.connect(open.clone());
    first.initialize(&client(), peer("a")).await.unwrap();
    first.detach();
    f.armed().await;
    f.clock.advance_to(10_000);
    let second = f.registry.connect(open);
    second.resume("session-1", peer("b")).await.unwrap();
    f.clock.advance_to(DETACHED_TTL_MS * 2);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(f.closes(), 0);
    assert!(second.attached().is_ok());
    assert!(!*f.link(0).retired().borrow());
}

#[tokio::test]
async fn dropping_a_connection_detaches_its_session_for_resume() {
    let mut f = Fixture::new();
    let open = f.opener(Knobs::default());
    {
        let first = f.registry.connect(open.clone());
        first.initialize(&client(), peer("a")).await.unwrap();
    }
    assert_eq!(f.armed().await, DETACHED_TTL_MS);
    let second = f.registry.connect(open);
    second.resume("session-1", peer("b")).await.unwrap();
    assert_eq!(f.closes(), 0);
}

#[tokio::test]
async fn a_failed_initialize_closes_its_resources_and_registers_nothing() {
    let f = Fixture::new();
    let failing = f.opener(Knobs {
        fail_initialize: true,
        ..Knobs::default()
    });
    let connection = f.registry.connect(failing);
    let error = connection
        .initialize(&client(), peer("a"))
        .await
        .unwrap_err();
    assert_eq!(error, Rejection::new(INTERNAL_ERROR, "initialize refused"));
    assert_eq!(f.closes(), 1);
    let other = f.registry.connect(f.opener(Knobs::default()));
    assert_eq!(
        other.resume("session-1", peer("b")).await.unwrap_err().code,
        INVALID_REQUEST
    );
}

#[tokio::test]
async fn a_duplicate_session_id_is_refused_and_its_resources_closed() {
    let f = Fixture::new();
    let first = f.registry.connect(f.opener(Knobs::default()));
    first.initialize(&client(), peer("a")).await.unwrap();
    let second = f.registry.connect(f.opener(Knobs::default()));
    let error = second.initialize(&client(), peer("b")).await.unwrap_err();
    assert_eq!(
        error,
        Rejection::new(INTERNAL_ERROR, "duplicate session id")
    );
    assert_eq!(f.closes(), 1);
    assert!(first.attached().is_ok());
    assert!(second.attached().is_err());
}

#[tokio::test]
async fn shutdown_retires_every_session_and_refuses_new_ones() {
    let f = Fixture::new();
    let first = f.registry.connect(f.opener(Knobs {
        id: "session-1",
        ..Knobs::default()
    }));
    first.initialize(&client(), peer("a")).await.unwrap();
    let second = f.registry.connect(f.opener(Knobs {
        id: "session-2",
        ..Knobs::default()
    }));
    second.initialize(&client(), peer("b")).await.unwrap();
    second.detach();
    f.registry.shutdown().await.unwrap();
    assert_eq!(f.closes(), 2);
    assert!(*f.link(0).retired().borrow() && *f.link(1).retired().borrow());
    assert_eq!(peer_name(&f.link(0)), None);
    assert!(first.attached().is_err());
    let late = f.registry.connect(f.opener(Knobs {
        id: "session-3",
        ..Knobs::default()
    }));
    let refused = late.initialize(&client(), peer("c")).await.unwrap_err();
    assert_eq!(refused.code, INTERNAL_ERROR);
    assert_eq!(
        late.resume("session-1", peer("c")).await.unwrap_err().code,
        INTERNAL_ERROR
    );
    assert_eq!(f.created.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_resource_that_fails_to_close_is_reported_as_a_cleanup_failure() {
    let f = Fixture::new();
    let connection = f.registry.connect(f.opener(Knobs {
        fail_close: true,
        ..Knobs::default()
    }));
    connection.initialize(&client(), peer("a")).await.unwrap();
    assert_eq!(
        f.registry.shutdown().await.unwrap_err().failures,
        [super::CleanupFailure::ResourceClose]
    );
    assert_eq!(f.closes(), 1);
    assert_eq!(
        f.lines.lock().unwrap().as_slice(),
        ["CCA executor cleanup-failed"]
    );
}

#[tokio::test]
async fn a_rejection_message_keeps_an_unpaired_unit_through_initialize() {
    let f = Fixture::new();
    let failing = f.opener(Knobs {
        fail_initialize: true,
        lone_unit: true,
        ..Knobs::default()
    });
    let connection = f.registry.connect(failing);
    let error = connection
        .initialize(&client(), peer("a"))
        .await
        .unwrap_err();
    assert_eq!(error.code, INTERNAL_ERROR);
    assert_eq!(
        error.message.code_units().collect::<Vec<_>>(),
        [0x62, 0xd800]
    );
    assert_ne!(error.message, LosslessString::from("b\u{fffd}"));
    assert_eq!(
        error,
        Rejection::new(
            INTERNAL_ERROR,
            LosslessString::from_utf16(vec![0x62, 0xd800])
        )
    );
    assert_eq!(f.closes(), 1);
}

#[test]
fn rejections_compare_by_code_units_and_accept_text_or_lossless_messages() {
    assert_eq!(
        Rejection::new(INVALID_REQUEST, "x"),
        Rejection::new(INVALID_REQUEST, String::from("x"))
    );
    assert_eq!(
        Rejection::new(INVALID_REQUEST, "x"),
        Rejection::new(INVALID_REQUEST, LosslessString::from_utf16(vec![0x78]))
    );
    assert_ne!(
        Rejection::new(INVALID_REQUEST, "x"),
        Rejection::new(INTERNAL_ERROR, "x")
    );
    assert_ne!(
        Rejection::new(INVALID_REQUEST, "x"),
        Rejection::new(INVALID_REQUEST, "y")
    );
}

#[tokio::test]
async fn the_client_name_reaches_the_resources_as_the_original_units() {
    let f = Fixture::new();
    let connection = f.registry.connect(f.opener(Knobs::default()));
    let name = LosslessString::from_utf16(vec![0x63, 0xd800]);
    connection.initialize(&name, peer("a")).await.unwrap();
    let created = f.created.lock().unwrap();
    let fake = created[0].downcast_ref::<Fake>().unwrap();
    assert_eq!(fake.client_name.lock().unwrap().clone(), Some(name));
}
