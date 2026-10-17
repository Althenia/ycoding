use super::{Events, Resolved, StreamInput, Streamed, consume};
use crate::{
    resources::{
        agent,
        catalog::{Catalog, models_dev},
        model,
    },
    session::{provider_request, store::Service, usage_activity, usage_attribution::Attribution},
    test_support,
    tools::code_mode::Cancellation,
};
use std::{
    collections::VecDeque,
    future::{Future, pending, poll_fn},
    io::Write,
    ops::Bound,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    task::Poll,
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_ai::llm;
use ycoding_schema::{JsonValue, parse_json, session};
use ycoding_store::{IndexOrder, Store, resources, session::EventTable};

const BOUND: Duration = Duration::from_secs(3);
const TOKENS: &str = r#"{"input":11,"output":7,"reasoning":0,"cache":{"read":3,"write":2}}"#;

#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl Logs {
    fn dispatch(&self) -> tracing::Dispatch {
        let logs = self.clone();
        tracing::Dispatch::new(
            tracing_subscriber::fmt()
                .without_time()
                .with_ansi(false)
                .with_target(false)
                .with_level(false)
                .with_writer(move || logs.clone())
                .finish(),
        )
    }

    fn assert_failure(&self, message: &str, category: &str) {
        let bytes = self.0.lock().unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert_eq!(text.lines().count(), 1, "one failure must be observable");
        let (logged_message, fields) = text.trim().split_once(" request_id=").unwrap();
        assert_eq!(logged_message, message);
        let (id, logged_category) = fields.split_once(" category=").unwrap();
        ycoding_schema::provider_request::Id::new(id).unwrap();
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        );
        assert_eq!(logged_category, format!("\"{category}\""));
    }
}

struct Script {
    events: VecDeque<llm::Event>,
    consumed: Arc<Notify>,
    stopped: Arc<AtomicUsize>,
}

impl Events for Script {
    async fn next(&mut self) -> Result<Option<llm::Event>, ycoding_ai::Error> {
        if let Some(event) = self.events.pop_front() {
            return Ok(Some(event));
        }
        self.consumed.notify_one();
        pending().await
    }
}

impl Drop for Script {
    fn drop(&mut self) {
        self.stopped.fetch_add(1, Ordering::SeqCst);
    }
}

struct World {
    store: Store,
    service: Service,
    session: session::Info,
    resolved: Resolved,
    agent: ycoding_schema::agent::Info,
    consumed: Arc<Notify>,
    stopped: Arc<AtomicUsize>,
}

impl World {
    fn new() -> Self {
        let store = test_support::store();
        let service = Service::new(store.client());
        let mut catalog = Catalog::new(models_dev::normalize(
            &parse_json(
                r#"{"anthropic":{"id":"anthropic","name":"Synthetic","env":[],"npm":"@ai-sdk/anthropic","models":{"judge":{"id":"judge","name":"Judge","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{"context":10000,"output":2048},"cost":{"input":1,"output":2,"cache_read":0.1,"cache_write":1.25}}}}}"#,
            )
            .unwrap(),
        )
        .unwrap());
        catalog.configure(&[parse_json(
            r#"{"model":{"providerID":"anthropic","model":"judge"},"providers":{"anthropic":{"package":"@ycoding-ai/ai/providers/anthropic","settings":{"apiKey":"synthetic"}}}}"#,
        ).unwrap()]).unwrap();
        let selection = ycoding_schema::model::Ref {
            provider_id: ycoding_schema::provider::Id("anthropic".into()),
            id: "judge".into(),
            variant: None,
            profile: None,
        };
        let info = model::Resolver::new(catalog)
            .resolve(&selection, &[], None)
            .unwrap()
            .info;
        let resolved = Resolved {
            model: model::from_catalog_model(&info, None).unwrap(),
            selection,
            info,
            account_identity: None,
        };
        Self {
            session: service
                .get(&session::Id::new("ses_one").unwrap())
                .unwrap()
                .unwrap(),
            store,
            service,
            resolved,
            agent: agent::empty("decision".into()),
            consumed: Arc::new(Notify::new()),
            stopped: Arc::new(AtomicUsize::new(0)),
        }
    }

    async fn run(&self, cancellation: &Cancellation, usage: bool) -> Result<Streamed, String> {
        let begin = provider_request::Begin {
            session: self.session.id.clone(),
            model: self.resolved.selection.clone(),
            route_id: self.resolved.model.route.id.clone(),
            connection_identity_digest: None,
            prompt_cache_key: "a".repeat(64),
            system_digest: "b".repeat(64),
            tool_digest: "c".repeat(64),
        };
        let pending = self
            .service
            .begin_provider_request_attributed(&begin, Attribution::Unanchored)
            .await
            .unwrap();
        consume(
            &self.service,
            &StreamInput {
                session: &self.session,
                resolved: &self.resolved,
                agent: &self.agent,
                source: "decision",
                input_id: None,
                request: llm::Request::new(self.resolved.model.clone()),
                cancellation,
                byte_limit: Some(1024),
                require_stop: true,
                attribution: Attribution::Unanchored,
            },
            begin,
            pending,
            std::future::ready(Ok(Script {
                events: if usage {
                    VecDeque::from([llm::Event::StepFinish {
                        index: 0.0,
                        finish: llm::Finish {
                            reason: llm::FinishReason::Stop,
                            usage: Some(llm::Usage {
                                input_tokens: Some(16.0),
                                non_cached_input_tokens: Some(11.0),
                                output_tokens: Some(7.0),
                                cache_read_input_tokens: Some(3.0),
                                cache_write_input_tokens: Some(2.0),
                                ..Default::default()
                            }),
                            provider_metadata: None,
                        },
                    }])
                } else {
                    VecDeque::new()
                },
                consumed: self.consumed.clone(),
                stopped: self.stopped.clone(),
            })),
        )
        .await
    }

    async fn assert_settled(&self, usage: bool) {
        self.store.submit(|_| Ok(())).unwrap().await.unwrap();
        let snapshot = self.store.snapshot().unwrap();
        let requests = resources::requests(
            &snapshot,
            self.session.id.as_lossless(),
            IndexOrder::Ascending,
            None,
            10,
        )
        .unwrap();
        assert_eq!(requests.len(), 1, "one helper attempt must settle durably");
        let record = &requests[0].record;
        assert_eq!(record.attempts, 1);
        assert_eq!(record.source.as_str(), Some("decision"));
        let tokens = parse_json(if usage {
            TOKENS
        } else {
            r#"{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}"#
        })
        .unwrap();
        assert_eq!(record.tokens.value(), &tokens);
        if usage {
            assert!((record.cost.unwrap() - 0.0000278).abs() < 1e-12);
        } else {
            assert!(record.cost.is_none());
        }
        let events = snapshot
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
            .unwrap();
        for (kind, expected) in [
            ("session.usage.recorded.1", usize::from(usage)),
            ("session.provider.request.recorded.1", 1),
        ] {
            let matching = events
                .iter()
                .filter(|event| event.type_.as_str() == Some(kind))
                .collect::<Vec<_>>();
            assert_eq!(matching.len(), expected, "{kind} must settle exactly once");
            for event in matching {
                let JsonValue::Object(data) = &event.data else {
                    panic!("event data must be an object")
                };
                assert_eq!(data.get(&"tokens".into()), Some(&tokens));
            }
        }
        assert_eq!(self.stopped.load(Ordering::SeqCst), 1);
        assert!(
            usage_activity::snapshot(&self.service.client)
                .requests
                .is_empty()
        );
    }

    fn assert_unsettled(&self) {
        let snapshot = self.store.snapshot().unwrap();
        assert!(
            resources::requests(
                &snapshot,
                self.session.id.as_lossless(),
                IndexOrder::Ascending,
                None,
                10,
            )
            .unwrap()
            .is_empty()
        );
        assert!(
            snapshot
                .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
                .unwrap()
                .iter()
                .all(|event| !matches!(
                    event.type_.as_str(),
                    Some("session.usage.recorded.1" | "session.provider.request.recorded.1")
                ))
        );
        assert_eq!(self.stopped.load(Ordering::SeqCst), 1);
        assert!(
            usage_activity::snapshot(&self.service.client)
                .requests
                .is_empty()
        );
    }
}

#[tokio::test]
async fn helper_deadline_drop_preserves_consumed_usage_and_stops_stream() {
    let world = World::new();
    let cancellation = Cancellation::default();
    let mut call = Box::pin(world.run(&cancellation, true));
    tokio::time::timeout(BOUND, async {
        tokio::select! {
            _ = world.consumed.notified() => {},
            _ = &mut call => panic!("provider must remain open after usage"),
        }
    })
    .await
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(10), call)
            .await
            .is_err()
    );
    assert!(!cancellation.is_cancelled());
    world.assert_settled(true).await;
}

#[tokio::test]
async fn helper_outer_cancellation_preserves_consumed_usage_and_stops_stream() {
    let world = World::new();
    let cancellation = Cancellation::default();
    let mut call = Box::pin(async {
        tokio::select! {
            biased;
            _ = cancellation.cancelled() => None,
            result = world.run(&cancellation, true) => Some(result),
        }
    });
    tokio::time::timeout(BOUND, async {
        tokio::select! {
            _ = world.consumed.notified() => {},
            _ = &mut call => panic!("provider must remain open after usage"),
        }
    })
    .await
    .unwrap();
    cancellation.cancel();
    assert!(call.await.is_none());
    world.assert_settled(true).await;
}

#[tokio::test]
async fn helper_cooperative_cancellation_preserves_only_reported_usage() {
    for usage in [true, false] {
        let world = World::new();
        let cancellation = Cancellation::default();
        let mut call = Box::pin(world.run(&cancellation, usage));
        tokio::time::timeout(BOUND, async {
            tokio::select! {
                _ = world.consumed.notified() => {},
                _ = &mut call => panic!("provider must remain open"),
            }
        })
        .await
        .unwrap();
        cancellation.cancel();
        let result = tokio::time::timeout(BOUND, call).await.unwrap().unwrap();
        assert!(result.cancelled);
        assert_eq!(result.tokens.is_some(), usage);
        world.assert_settled(usage).await;
    }
}

#[tokio::test]
async fn helper_drop_during_queued_settlement_keeps_both_ledger_events() {
    let world = World::new();
    let active_at_commit = Arc::new(AtomicUsize::new(0));
    let observed = active_at_commit.clone();
    let client = world.store.client();
    world.store.observe_events(move |events| {
        if !events
            .iter()
            .any(|event| event.type_.as_str() == Some("session.provider.request.recorded.1"))
        {
            return true;
        }
        observed.store(
            usage_activity::snapshot(&client).requests.len(),
            Ordering::SeqCst,
        );
        false
    });
    let cancellation = Cancellation::default();
    let mut call = Box::pin(world.run(&cancellation, true));
    tokio::time::timeout(BOUND, async {
        tokio::select! {
            _ = world.consumed.notified() => {},
            _ = &mut call => panic!("provider must remain open after usage"),
        }
    })
    .await
    .unwrap();
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let gate = world
        .store
        .submit(move |_| {
            started.send(()).unwrap();
            blocked.recv_timeout(BOUND).unwrap();
            Ok(())
        })
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    cancellation.cancel();
    let settlement_pending =
        poll_fn(|context| Poll::Ready(call.as_mut().poll(context).is_pending())).await;
    drop(call);
    let active_while_queued = usage_activity::snapshot(&world.service.client)
        .requests
        .len();
    release.send(()).unwrap();
    gate.await.unwrap();
    assert!(
        settlement_pending,
        "the blocked writer must hold settlement"
    );
    assert_eq!(active_while_queued, 1);
    world.assert_settled(true).await;
    assert_eq!(active_at_commit.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn helper_drop_reports_queue_rejection_without_payload_or_error_text() {
    let world = World::new();
    let cancellation = Cancellation::default();
    let mut call = Box::pin(world.run(&cancellation, true));
    tokio::time::timeout(BOUND, async {
        tokio::select! {
            _ = world.consumed.notified() => {},
            _ = &mut call => panic!("provider must remain open after usage"),
        }
    })
    .await
    .unwrap();
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let gate = world
        .store
        .submit(move |_| {
            started.send(()).unwrap();
            blocked.recv_timeout(BOUND).unwrap();
            Ok(())
        })
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    let queued = (0..ycoding_store::Options::core().queue_capacity)
        .map(|_| world.store.submit(|_| Ok(())).unwrap())
        .collect::<Vec<_>>();
    let logs = Logs::default();
    tracing::dispatcher::with_default(&logs.dispatch(), || drop(call));
    release.send(()).unwrap();
    gate.await.unwrap();
    for receipt in queued {
        receipt.await.unwrap();
    }
    logs.assert_failure("Helper settlement admission failed", "queue_full");
    assert!(!cancellation.is_cancelled());
    world.assert_unsettled();
}

#[tokio::test]
async fn helper_drop_reports_projection_failure_and_rolls_back_ledger_events() {
    let world = World::new();
    let cancellation = Cancellation::default();
    let mut call = Box::pin(world.run(&cancellation, true));
    tokio::time::timeout(BOUND, async {
        tokio::select! {
            _ = world.consumed.notified() => {},
            _ = &mut call => panic!("provider must remain open after usage"),
        }
    })
    .await
    .unwrap();
    world
        .store
        .submit(|tx| {
            let mut session = test_support::record("ses_one");
            session.tokens_input = i64::MAX;
            ycoding_store::session::SessionTable::put(tx, &session)
        })
        .unwrap()
        .await
        .unwrap();
    let logs = Logs::default();
    tracing::dispatcher::with_default(&logs.dispatch(), || drop(call));
    world.store.submit(|_| Ok(())).unwrap().await.unwrap();
    logs.assert_failure("Helper settlement failed", "transaction_rejected");
    assert!(!world.store.is_fenced());
    let session = world
        .store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::session::SessionTable>(&crate::session::key(
            world.session.id.as_lossless(),
        ))
        .unwrap()
        .unwrap();
    assert_eq!(session.cost, 0.0);
    assert_eq!(session.tokens_input, i64::MAX);
    assert_eq!(session.tokens_output, 0);
    world.assert_unsettled();
}

#[tokio::test]
async fn helper_drop_reports_fenced_accepted_work_without_a_receipt() {
    let mut world = World::new();
    let catalog = world.store.catalog();
    let project = world
        .store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::project::ProjectTable>(&crate::session::key(
            world.session.project_id.as_lossless(),
        ))
        .unwrap()
        .unwrap();
    let path = std::env::temp_dir().join(format!(
        "ycoding-helper-fenced-{}.redb",
        provider_request::new_id()
            .unwrap()
            .as_lossless()
            .to_utf8()
            .unwrap()
    ));
    let store = Store::initialize(
        &path,
        ycoding_store::Options::core(),
        catalog,
        world.store.metadata().clone(),
    )
    .unwrap();
    store
        .submit(move |tx| {
            ycoding_store::project::ProjectTable::insert(tx, &project)?;
            ycoding_store::session::SessionTable::insert(tx, &test_support::record("ses_one"))
        })
        .unwrap()
        .await
        .unwrap();
    world.service = Service::new(store.client());
    world.store = store;
    let cancellation = Cancellation::default();
    let mut call = Box::pin(world.run(&cancellation, true));
    tokio::time::timeout(BOUND, async {
        tokio::select! {
            _ = world.consumed.notified() => {},
            _ = &mut call => panic!("provider must remain open after usage"),
        }
    })
    .await
    .unwrap();
    let (started, reached) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let gate = world
        .store
        .submit(move |_| -> Result<(), ycoding_store::Error> {
            started.send(()).unwrap();
            blocked.recv_timeout(BOUND).unwrap();
            panic!("synthetic writer panic");
        })
        .unwrap();
    reached.recv_timeout(BOUND).unwrap();
    let logs = Logs::default();
    tracing::dispatcher::with_default(&logs.dispatch(), || drop(call));
    let (settled, observed) = mpsc::channel();
    let barrier = world
        .store
        .submit_owned(
            |_| Ok(()),
            move |result| {
                settled
                    .send(matches!(result, Err(ycoding_store::Error::WriterFenced)))
                    .unwrap();
            },
        )
        .unwrap();
    release.send(()).unwrap();
    assert!(matches!(
        gate.await,
        Err(ycoding_store::Error::WriterPanicked)
    ));
    assert!(matches!(
        barrier.await,
        Err(ycoding_store::Error::WriterFenced)
    ));
    assert!(observed.recv_timeout(BOUND).unwrap());
    logs.assert_failure("Helper settlement failed", "writer_fenced");
    assert!(world.store.is_fenced());
    assert!(matches!(
        world.store.snapshot(),
        Err(ycoding_store::Error::WriterFenced)
    ));
    assert_eq!(world.stopped.load(Ordering::SeqCst), 1);
    assert!(
        usage_activity::snapshot(&world.service.client)
            .requests
            .is_empty()
    );
    world.store.shutdown().unwrap();
    let store = Store::open(&path, ycoding_store::Options::core(), catalog).unwrap();
    let world = World {
        service: Service::new(store.client()),
        store,
        ..world
    };
    world.assert_unsettled();
    drop(world);
    std::fs::remove_file(path).unwrap();
}
