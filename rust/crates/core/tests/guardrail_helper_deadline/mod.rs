use super::{
    Adapter, Attribution, Cancellation, ENABLED, Fake, Grading, Invocation, Limits, Reply,
    Verification, adapter, decision, escalated, evidence, field, grade, ordinary, ordinary_grades,
    predicate, settled, sid, verify,
};
use std::{
    ops::Bound,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use ycoding_ai::route::{AttemptPhase, Executor};
use ycoding_core::{
    resources::{
        agent,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::store::Service,
    tools::policy::helper::{Models, Settings},
};
use ycoding_schema::{JsonValue, ObjectEncoder, parse_json, session_review, stringify_json};
use ycoding_store::{IndexOrder, Store, resources, session::EventTable};

#[path = "../session_support/mod.rs"]
mod support;

const BOUND: Duration = Duration::from_secs(3);
const TOKENS: &str = r#"{"input":11,"output":7,"reasoning":0,"cache":{"read":3,"write":2}}"#;

struct World {
    store: Store,
    service: Arc<decision::Service>,
    calls: Arc<AtomicUsize>,
    stopped: Arc<AtomicUsize>,
    disconnected: Arc<Notify>,
    shutdown: Cancellation,
    server: tokio::task::JoinHandle<()>,
}

impl World {
    async fn new(reply: Reply) -> Self {
        let Reply::Value(reply) = reply else {
            panic!("the provider fixture requires a valid answer")
        };
        let text = stringify_json(
            &ObjectEncoder::new()
                .field(
                    "decisions",
                    &ObjectEncoder::new()
                        .field("version", &1.0)
                        .field("answers", field(&reply, &["response", "answers"]))
                        .finish(),
                )
                .finish(),
        );
        let body = format!(
            "data: {{\"type\":\"message_start\",\"message\":{{\"usage\":{{\"input_tokens\":11,\"output_tokens\":0,\"cache_read_input_tokens\":3,\"cache_creation_input_tokens\":2}}}}}}\n\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":{}}}}}\n\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}},\"usage\":{{\"output_tokens\":7}}}}\n\n",
            stringify_json(&JsonValue::String(text.into()))
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let calls = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicUsize::new(0));
        let disconnected = Arc::new(Notify::new());
        let shutdown = Cancellation::default();
        let server = {
            let calls = calls.clone();
            let disconnected = disconnected.clone();
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                loop {
                    let (mut stream, _) = tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    calls.fetch_add(1, Ordering::SeqCst);
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let boundary = loop {
                        let read = stream.read(&mut buffer).await.unwrap();
                        assert!(read > 0);
                        request.extend_from_slice(&buffer[..read]);
                        if let Some(boundary) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                            break boundary + 4;
                        }
                    };
                    let length = std::str::from_utf8(&request[..boundary])
                        .unwrap()
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap();
                    while request.len() - boundary < length {
                        let read = stream.read(&mut buffer).await.unwrap();
                        assert!(read > 0);
                        request.extend_from_slice(&buffer[..read]);
                    }
                    stream
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len(),
                            )
                            .as_bytes(),
                        )
                        .await
                        .unwrap();
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        read = stream.read(&mut buffer) => {
                            assert!(matches!(read, Ok(0) | Err(_)), "unexpected provider input");
                            disconnected.notify_one();
                        }
                    }
                }
            })
        };
        let store = support::store();
        store
            .submit(|tx| {
                ycoding_store::session::SessionTable::insert(tx, &support::record("ses_child"))?;
                ycoding_store::session::SessionTable::insert(tx, &support::record("ses_root"))
            })
            .unwrap()
            .wait()
            .unwrap();
        let sessions = Service::new(store.client());
        let mut catalog = Catalog::new(
            models_dev::normalize(
                &parse_json(
                    r#"{"anthropic":{"id":"anthropic","name":"Synthetic","env":[],"npm":"@ai-sdk/anthropic","models":{"judge":{"id":"judge","name":"Judge","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{"context":10000,"output":2048},"cost":{"input":1,"output":2,"cache_read":0.1,"cache_write":1.25}}}}}"#,
                )
                .unwrap(),
            )
            .unwrap(),
        );
        catalog
            .configure(&[parse_json(&format!(
                r#"{{"model":{{"providerID":"anthropic","model":"judge"}},"providers":{{"anthropic":{{"package":"@ycoding-ai/ai/providers/anthropic","settings":{{"apiKey":"synthetic","baseURL":"{endpoint}"}}}}}}}}"#
            ))
            .unwrap()])
            .unwrap();
        let models = Arc::new(Models {
            models: Arc::new(model::Resolver::new(catalog)),
            credentials: credential::Service::new(store.client()),
            auth: Default::default(),
            cursor: None,
            claude: None,
            store: sessions.clone(),
            settings: Settings::default(),
        });
        let mut executor = Executor::new(Executor::http_client().unwrap());
        executor.observer = Some({
            let stopped = stopped.clone();
            Arc::new(move |attempt| {
                if attempt.phase != AttemptPhase::Started {
                    stopped.fetch_add(1, Ordering::SeqCst);
                }
                Ok(())
            })
        });
        Self {
            service: Arc::new(decision::Service {
                store: sessions,
                agents: Arc::new(agent::Service::new(vec![agent::empty("decision".into())])),
                models,
                executor: Arc::new(executor),
            }),
            store,
            calls,
            stopped,
            disconnected,
            shutdown,
            server,
        }
    }

    fn adapter(&self) -> Adapter {
        Adapter {
            evaluator: self.service.clone(),
            redact: Arc::new(Clone::clone),
            policy: ENABLED,
            limits: Limits {
                verify: Duration::from_secs(30),
                grade: Duration::from_secs(30),
            },
        }
    }

    fn assert_usage(&self) {
        let snapshot = self.store.snapshot().unwrap();
        let requests = resources::requests(
            &snapshot,
            &"ses_child".into(),
            IndexOrder::Ascending,
            None,
            10,
        )
        .unwrap();
        assert_eq!(requests.len(), 1, "one durable helper request must settle");
        let record = &requests[0].record;
        assert_eq!(record.source.as_str(), Some("decision"));
        assert_eq!(record.attempts, 1);
        assert_eq!(record.tokens.value(), &parse_json(TOKENS).unwrap());
        assert!((record.cost.unwrap() - 0.0000278).abs() < 1e-12);
        let events = snapshot
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
            .unwrap();
        for kind in [
            "session.usage.recorded.1",
            "session.provider.request.recorded.1",
        ] {
            let matching = events
                .iter()
                .filter(|event| {
                    event.aggregate_id == "ses_child".into() && event.type_.as_str() == Some(kind)
                })
                .collect::<Vec<_>>();
            assert_eq!(matching.len(), 1, "{kind} must be recorded exactly once");
            assert_eq!(
                field(&matching[0].data, &["tokens"]),
                &parse_json(TOKENS).unwrap()
            );
        }
        assert_eq!(
            self.calls.load(Ordering::SeqCst),
            1,
            "attempts must not replay"
        );
        assert_eq!(
            self.stopped.load(Ordering::SeqCst),
            1,
            "the provider attempt must stop"
        );
    }

    async fn stop(&mut self) {
        self.shutdown.cancel();
        match tokio::time::timeout(BOUND, &mut self.server).await {
            Ok(result) => result.expect("synthetic provider failed"),
            Err(_) => {
                self.server.abort();
                let error = (&mut self.server).await.unwrap_err();
                assert!(error.is_cancelled());
                panic!("synthetic provider did not stop");
            }
        }
    }
}

#[tokio::test]
async fn verification_records_real_service_usage_for_a_completed_response() {
    let mut world = World::new(predicate(false, 0.99)).await;
    let cancellation = Cancellation::default();
    let result = tokio::time::timeout(
        BOUND,
        verify(
            &world.adapter(),
            &ordinary(),
            false,
            false,
            Some(&evidence()),
            &cancellation,
        ),
    )
    .await;
    let disconnected = tokio::time::timeout(BOUND, world.disconnected.notified()).await;
    world.stop().await;
    assert_eq!(
        result.unwrap(),
        Verification::Dismissed {
            rule_id: "standard.review.outside-repo".into(),
            confidence: super::confidence(0.99),
        }
    );
    assert!(
        disconnected.is_ok(),
        "a completed provider response must release the transport"
    );
    assert!(
        !cancellation.is_cancelled(),
        "helper completion must not cancel its caller"
    );
    world.assert_usage();
}

#[tokio::test]
async fn grading_records_real_service_usage_for_a_completed_response() {
    let mut world = World::new(ordinary_grades(0.1, 0.99, 0.1, 0.1)).await;
    let cancellation = Cancellation::default();
    let result = tokio::time::timeout(
        BOUND,
        grade(&world.adapter(), &ordinary(), false, false, &cancellation),
    )
    .await;
    let disconnected = tokio::time::timeout(BOUND, world.disconnected.notified()).await;
    world.stop().await;
    let result = result.unwrap();
    let (reply, provenance) = settled(&result);
    assert_eq!(reply, ycoding_schema::guardrail::Reply::Once);
    assert!(provenance.grades.is_some());
    assert!(
        disconnected.is_ok(),
        "a completed provider response must release the transport"
    );
    assert!(!cancellation.is_cancelled());
    world.assert_usage();
}

fn request() -> JsonValue {
    parse_json(r#"{"provider":"agent","request":{"state":null,"questions":[{"type":"predicate","name":"guardrail_match","instructions":"Does the rule match?"}]}}"#).unwrap()
}

#[tokio::test]
async fn precancelled_service_and_adapter_make_zero_provider_calls() {
    let mut world = World::new(predicate(false, 0.99)).await;
    let cancellation = Cancellation::default();
    cancellation.cancel();
    let result = world
        .service
        .evaluate(
            &request(),
            Invocation {
                session_id: &sid("ses_child"),
                input_id: None,
                cancellation: &cancellation,
                attribution: Attribution::Unanchored,
            },
        )
        .await;
    let verification = verify(
        &world.adapter(),
        &ordinary(),
        false,
        false,
        Some(&evidence()),
        &cancellation,
    )
    .await;
    let grading = grade(&world.adapter(), &ordinary(), false, false, &cancellation).await;
    world.stop().await;
    assert_eq!(result, Err(decision::Error::Cancelled));
    assert_eq!(verification, Verification::Cancelled);
    assert_eq!(grading, Grading::Cancelled);
    assert_eq!(world.calls.load(Ordering::SeqCst), 0);
    assert_eq!(world.stopped.load(Ordering::SeqCst), 0);
    assert!(
        resources::requests(
            &world.store.snapshot().unwrap(),
            &"ses_child".into(),
            IndexOrder::Ascending,
            None,
            10,
        )
        .unwrap()
        .is_empty()
    );
}

#[tokio::test]
async fn noncooperative_evaluators_remain_deadline_bounded() {
    let fake = Fake::with(vec![Reply::Hang, Reply::Hang]);
    let adapter = adapter(&fake, ENABLED);
    let cancellation = Cancellation::default();
    assert_eq!(
        tokio::time::timeout(
            Duration::from_millis(250),
            verify(
                &adapter,
                &ordinary(),
                false,
                false,
                Some(&evidence()),
                &cancellation,
            )
        )
        .await
        .expect("verification must remain bounded"),
        Verification::Kept
    );
    let result = tokio::time::timeout(
        Duration::from_millis(250),
        grade(&adapter, &ordinary(), false, false, &cancellation),
    )
    .await
    .expect("grading must remain bounded");
    assert_eq!(escalated(&result).0, session_review::Reason::Timeout);
    assert_eq!(fake.calls(), 2);
}
