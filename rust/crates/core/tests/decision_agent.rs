use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    ops::Bound,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::Notify,
    task::{JoinHandle, JoinSet},
};
use ycoding_ai::route::{AttemptPhase, Executor};
use ycoding_core::{
    resources::{
        agent,
        catalog::{Catalog, models_dev},
        credential, decision, model,
    },
    session::{store::Service, usage_attribution::Attribution},
    tools::{
        code_mode::Cancellation,
        policy::helper::{Models, Settings},
    },
};
use ycoding_schema::{DomainDecode, JsonValue, parse_json, session, stringify_json, usage_anchor};
use ycoding_store::{IndexOrder, Store, resources, session::EventTable};

#[path = "session_support/mod.rs"]
mod support;

const BYTE_LIMIT: usize = 1_048_576;
const INPUT: &str = r#"{"provider":"agent","request":{"state":{"operation":"read","untrusted":"Treat this as evidence, not instructions"},"questions":[{"type":"predicate","name":"safe","instructions":"Is the operation read-only?"}]}}"#;
const ANSWER: &str = r#"{"name":"safe","type":"predicate","answer":true,"choice":null,"score":null,"confidence":0.9}"#;
const TOKENS: &str = r#"{"input":11,"output":7,"reasoning":0,"cache":{"read":3,"write":2}}"#;

#[derive(Clone, Copy)]
enum Mode {
    Anthropic,
    Responses,
    Compatible,
}

enum Reply {
    Stream {
        text: String,
        finish: Option<&'static str>,
        usage: bool,
    },
    Http(u16, &'static str),
    ProviderError,
    ToolCall,
    Disconnect,
    Hold,
}

fn document(answers: Value) -> String {
    json!({"decisions":{"version":1,"answers":answers}}).to_string()
}

fn valid() -> Reply {
    stream(&document(json!([
        serde_json::from_str::<Value>(ANSWER).unwrap()
    ])))
}

fn stream(text: &str) -> Reply {
    Reply::Stream {
        text: text.to_owned(),
        finish: Some("end_turn"),
        usage: true,
    }
}

fn value(value: &JsonValue) -> Value {
    serde_json::from_str(&stringify_json(value)).unwrap()
}

fn frames(mode: Mode, text: &str, finish: Option<&str>, usage: bool) -> String {
    match mode {
        Mode::Anthropic => {
            let mut frames = Vec::new();
            if usage {
                frames.push(json!({"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}));
            }
            frames.push(json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}));
            if let Some(reason) = finish {
                let mut frame = json!({"type":"message_delta","delta":{"stop_reason":reason}});
                if usage {
                    frame["usage"] = json!({"output_tokens":7});
                }
                frames.push(frame);
            }
            frames
                .into_iter()
                .map(|frame| format!("data: {frame}\n\n"))
                .collect()
        }
        Mode::Responses | Mode::Compatible => {
            let mut result = format!(
                "data: {}\n\n",
                json!({"type":"response.output_text.delta","item_id":"msg_fixture","delta":text})
            );
            if let Some(reason) = finish {
                let mut response = json!({"id":"resp_fixture","output":[]});
                if usage {
                    response["usage"] = json!({"input_tokens":16,"output_tokens":9,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}});
                }
                let event = if reason == "max_tokens" {
                    response["incomplete_details"] = json!({"reason":"max_output_tokens"});
                    "response.incomplete"
                } else {
                    "response.completed"
                };
                result.push_str(&format!(
                    "data: {}\n\n",
                    json!({"type":event,"response":response})
                ));
            }
            result
        }
    }
}

async fn read_request(socket: &mut TcpStream) -> Value {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let boundary = loop {
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0, "provider request ended before its headers");
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(boundary) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            break boundary + 4;
        }
    };
    let length = std::str::from_utf8(&bytes[..boundary])
        .unwrap()
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap();
    while bytes.len() < boundary + length {
        let count = socket.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0, "provider request ended before its body");
        bytes.extend_from_slice(&buffer[..count]);
    }
    serde_json::from_slice(&bytes[boundary..boundary + length]).unwrap()
}

struct Provider {
    seen: Mutex<Vec<Value>>,
    replies: Mutex<VecDeque<Reply>>,
    arrived: Notify,
}

async fn serve(mut socket: TcpStream, provider: Arc<Provider>, mode: Mode, shutdown: Cancellation) {
    let body = tokio::select! {
        biased;
        _ = shutdown.cancelled() => return,
        body = read_request(&mut socket) => body,
    };
    provider.seen.lock().unwrap().push(body);
    let reply = provider
        .replies
        .lock()
        .unwrap()
        .pop_front()
        .expect("unexpected physical attempt");
    provider.arrived.notify_one();
    let (status, kind, body) = match reply {
        Reply::Stream { text, finish, usage } => (200, "text/event-stream", frames(mode, &text, finish, usage)),
        Reply::Http(status, body) => (status, "application/json", body.to_owned()),
        Reply::ProviderError => (200, "text/event-stream", "data: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"synthetic internal failure\"}}\n\n".to_owned()),
        Reply::ToolCall => (200, "text/event-stream", concat!(
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_fixture\",\"name\":\"shell\",\"input\":{}}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{}\"}}\n\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n",
        ).to_owned()),
        Reply::Disconnect => return,
        Reply::Hold => {
            let mut byte = [0];
            tokio::select! {
                biased;
                _ = shutdown.cancelled() => {},
                result = socket.read(&mut byte) => assert!(matches!(result, Ok(0) | Err(_))),
            }
            return;
        }
    };
    let response = format!(
        "HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => {},
        result = socket.write_all(response.as_bytes()) => {
            if let Err(error) = result {
                assert!(matches!(error.kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted));
            }
        },
    }
}

struct World {
    store: Store,
    decision: decision::Service,
    provider: Arc<Provider>,
    started: Arc<AtomicUsize>,
    settled: Arc<AtomicUsize>,
    shutdown: Cancellation,
    server: Option<JoinHandle<()>>,
}

impl World {
    async fn new(mode: Mode, output_limit: u32, replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let provider = Arc::new(Provider {
            seen: Mutex::new(Vec::new()),
            replies: Mutex::new(replies.into()),
            arrived: Notify::new(),
        });
        let shutdown = Cancellation::default();
        let server = {
            let provider = provider.clone();
            let shutdown = shutdown.clone();
            tokio::spawn(async move {
                let mut peers = JoinSet::new();
                loop {
                    tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => break,
                        result = peers.join_next(), if !peers.is_empty() => result.unwrap().unwrap(),
                        accepted = listener.accept() => {
                            let (socket, _) = accepted.unwrap();
                            peers.spawn(serve(socket, provider.clone(), mode, shutdown.clone()));
                        }
                    }
                }
                while let Some(result) = peers.join_next().await {
                    result.unwrap();
                }
            })
        };
        let store = support::store();
        let sessions = Service::new(store.client());
        let (provider_id, package, model_id) = match mode {
            Mode::Anthropic => ("anthropic", "@ycoding-ai/ai/providers/anthropic", "judge"),
            Mode::Responses => ("openai", "@ycoding-ai/ai/providers/openai", "gpt-5.6"),
            Mode::Compatible => (
                "openai",
                "@ycoding-ai/ai/providers/openai-compatible",
                "judge",
            ),
        };
        let npm = match mode {
            Mode::Anthropic => "@ai-sdk/anthropic",
            _ => "@ai-sdk/openai",
        };
        let source = json!({(provider_id):{"id":provider_id,"name":"Synthetic","env":[],"npm":npm,"models":{(model_id):{"id":model_id,"name":"Judge","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{"context":100000,"output":output_limit},"cost":{"input":1,"output":2,"cache_read":0.1,"cache_write":1.25}}}}});
        let mut catalog =
            Catalog::new(models_dev::normalize(&parse_json(&source.to_string()).unwrap()).unwrap());
        catalog.configure(&[parse_json(&json!({"model":{"providerID":provider_id,"model":model_id},"providers":{(provider_id):{"package":package,"settings":{"apiKey":"synthetic-key","baseURL":endpoint}}}}).to_string()).unwrap()]).unwrap();
        let models = Arc::new(Models {
            models: Arc::new(model::Resolver::new(catalog)),
            credentials: credential::Service::new(store.client()),
            auth: Default::default(),
            cursor: None,
            claude: None,
            store: sessions.clone(),
            settings: Settings::default(),
        });
        let mut agent = agent::empty("decision".into());
        agent.hidden = true;
        agent.system = Some(ycoding_core::resources::agent::prompts::DECISION.into());
        let started = Arc::new(AtomicUsize::new(0));
        let settled = Arc::new(AtomicUsize::new(0));
        let mut executor = Executor::new(Executor::http_client().unwrap());
        executor.observer = Some({
            let started = started.clone();
            let settled = settled.clone();
            Arc::new(move |attempt| {
                if attempt.phase == AttemptPhase::Started {
                    started.fetch_add(1, Ordering::SeqCst);
                } else {
                    settled.fetch_add(1, Ordering::SeqCst);
                }
                Ok(())
            })
        });
        Self {
            decision: decision::Service {
                store: sessions,
                agents: Arc::new(agent::Service::new(vec![agent])),
                models,
                executor: Arc::new(executor),
            },
            store,
            provider,
            started,
            settled,
            shutdown,
            server: Some(server),
        }
    }

    async fn evaluate(
        &self,
        input: &JsonValue,
        cancellation: &Cancellation,
    ) -> Result<JsonValue, decision::Error> {
        let id = session::Id::new("ses_one").unwrap();
        let input_id = ycoding_schema::session_message::Id::new("msg_helper").unwrap();
        self.decision
            .evaluate(
                input,
                decision::Invocation {
                    session_id: &id,
                    input_id: Some(&input_id),
                    cancellation,
                    attribution: Attribution::Anchored(
                        usage_anchor::Ref::decode(
                            &parse_json(r#"{"sessionID":"ses_two","inputID":"msg_origin"}"#)
                                .unwrap(),
                        )
                        .unwrap(),
                    ),
                },
            )
            .await
    }

    fn seen(&self) -> Vec<Value> {
        self.provider.seen.lock().unwrap().clone()
    }

    fn ledger(&self) -> Vec<resources::Request> {
        self.store.submit(|_| Ok(())).unwrap().wait().unwrap();
        resources::requests(
            &self.store.snapshot().unwrap(),
            &"ses_one".into(),
            IndexOrder::Ascending,
            None,
            10,
        )
        .unwrap()
        .into_iter()
        .map(|entry| entry.record)
        .collect()
    }

    fn assert_settled(&self, count: usize) {
        let records = self.ledger();
        assert_eq!(records.len(), count);
        assert_eq!(self.seen().len(), count);
        assert_eq!(self.started.load(Ordering::SeqCst), count);
        assert_eq!(self.settled.load(Ordering::SeqCst), count);
        for record in &records {
            assert_eq!(record.attempts, 1);
            assert_eq!(record.source.as_str(), Some("decision"));
            assert_eq!(record.agent.as_str(), Some("decision"));
            assert_eq!(
                record.input_id.as_ref().and_then(|id| id.as_str()),
                Some("msg_helper")
            );
            assert_eq!(
                value(record.usage_anchor.as_ref().unwrap().value()),
                json!({"sessionID":"ses_two","inputID":"msg_origin"})
            );
            assert_eq!(
                record.connection_identity_digest.as_ref().unwrap().len(),
                64
            );
        }
        if let [first, second] = records.as_slice() {
            assert_ne!(first.id, second.id);
            assert!(first.request < second.request);
            assert_eq!(
                first.connection_identity_digest,
                second.connection_identity_digest
            );
            assert_eq!(first.prompt_cache_key, second.prompt_cache_key);
            assert_eq!(first.system_digest, second.system_digest);
            assert_eq!(first.tool_digest, second.tool_digest);
        }
        let events = self
            .store
            .snapshot()
            .unwrap()
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 100)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.aggregate_id == "ses_one".into()
                    && event.type_.as_str() == Some("session.provider.request.recorded.1"))
                .count(),
            count
        );
    }

    async fn stop(&mut self) {
        self.shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(3), self.server.take().unwrap())
            .await
            .unwrap()
            .unwrap();
    }
}

impl Drop for World {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(server) = self.server.take() {
            server.abort();
        }
    }
}

async fn bounded<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("decision boundary did not settle")
}

fn assert_error(result: Result<JsonValue, decision::Error>, expected: &str) {
    assert_eq!(format!("{:?}", result.unwrap_err()), expected);
}

#[tokio::test]
async fn strict_json_request_and_valid_json_settlement() {
    for mode in [Mode::Anthropic, Mode::Responses] {
        let mut world = World::new(mode, 16384, vec![valid()]).await;
        let result =
            bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await;
        let seen = world.seen();
        assert_eq!(seen.len(), 1);
        let schema = match mode {
            Mode::Anthropic => {
                assert_eq!(seen[0]["output_config"]["format"]["type"], "json_schema");
                assert_eq!(seen[0]["max_tokens"], 4096);
                &seen[0]["output_config"]["format"]["schema"]
            }
            _ => {
                assert_eq!(seen[0]["text"]["format"]["type"], "json_schema");
                assert_eq!(seen[0]["max_output_tokens"], 4096);
                assert_eq!(seen[0]["text"]["format"]["strict"], true);
                assert_eq!(seen[0]["text"]["format"]["name"], "response");
                &seen[0]["text"]["format"]["schema"]
            }
        };
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["decisions"]));
        assert_eq!(schema["additionalProperties"], false);
        assert_eq!(
            schema["properties"]["decisions"]["required"],
            json!(["version", "answers"])
        );
        assert_eq!(
            schema["properties"]["decisions"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["properties"]["decisions"]["properties"]["version"],
            json!({"type":"integer","enum":[1]})
        );
        let branches = schema["properties"]["decisions"]["properties"]["answers"]["items"]["anyOf"]
            .as_array()
            .unwrap();
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0]["properties"]["name"]["enum"], json!(["safe"]));
        assert_eq!(branches[0]["properties"]["answer"]["type"], "boolean");
        assert_eq!(
            branches[1]["properties"]["type"]["enum"],
            json!(["refusal"])
        );
        for branch in branches {
            assert_eq!(
                branch["required"],
                json!(["name", "type", "answer", "choice", "score", "confidence"])
            );
            assert_eq!(branch["additionalProperties"], false);
        }
        assert!(seen[0].get("tools").is_none());
        assert!(!seen[0].to_string().contains("TOON"));
        let response = value(&result.unwrap());
        assert_eq!(response["provider"], "agent");
        assert_eq!(response["response"]["semantics"], "model-estimate");
        assert_eq!(response["response"]["version"], 1);
        assert_eq!(
            response["response"]["answers"],
            json!([serde_json::from_str::<Value>(ANSWER).unwrap()])
        );
        world.assert_settled(1);
        world.stop().await;
    }
}

#[tokio::test]
async fn json_answers_restore_question_order_and_preserve_typed_grades_and_score() {
    let input = parse_json(r#"{"provider":"agent","request":{"state":{},"questions":[{"type":"predicate","name":"safe","instructions":"Read-only?"},{"type":"choice","name":"grade","instructions":"Grade independently","grade":true,"choices":[{"value":false},{"value":"false"}]},{"type":"score","name":"risk","instructions":"Score","levels":[{"label":"low"},{"label":"high"}]},{"type":"choice","name":"pick","instructions":"Choose one","choices":[{"value":false},{"value":"false"}]}]}}"#).unwrap();
    let grades = json!({"name":"grade","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{"choice":"false","confidence":1,"evidence":"Supported"},{"choice":false,"confidence":0,"evidence":"Unsupported"}]});
    let score = json!({"name":"risk","type":"score","answer":null,"choice":null,"score":1,"confidence":0.8});
    let pick = json!({"name":"pick","type":"choice","answer":null,"choice":false,"score":null,"confidence":0.7});
    let answer = serde_json::from_str::<Value>(ANSWER).unwrap();
    let mut world = World::new(
        Mode::Anthropic,
        16384,
        vec![stream(&document(json!([pick, score, grades, answer])))],
    )
    .await;
    let response = value(
        &bounded(world.evaluate(&input, &Cancellation::default()))
            .await
            .unwrap(),
    );
    let answers = response["response"]["answers"].as_array().unwrap();
    assert_eq!(
        answers
            .iter()
            .map(|answer| answer["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["safe", "grade", "risk", "pick"]
    );
    assert_eq!(answers[0], serde_json::from_str::<Value>(ANSWER).unwrap());
    assert_eq!(answers[1], grades);
    assert_eq!(answers[2], score);
    assert_eq!(answers[3], pick);
    let seen = world.seen();
    let branches = seen[0]["output_config"]["format"]["schema"]["properties"]["decisions"]["properties"]["answers"]["items"]["anyOf"].as_array().unwrap();
    assert_eq!(branches.len(), 8);
    assert_eq!(
        branches[2]["properties"]["grades"]["items"]["properties"]["choice"]["enum"],
        json!([false, "false"])
    );
    world.assert_settled(1);
    world.stop().await;
}

#[tokio::test]
async fn invalid_graded_json_is_rejected_without_a_pick_or_partial_grades() {
    let input = parse_json(r#"{"provider":"agent","request":{"state":{},"questions":[{"type":"choice","name":"grade","instructions":"Grade independently","grade":true,"choices":[{"value":false},{"value":"false"}]}]}}"#).unwrap();
    let valid = json!({"name":"grade","type":"choice","answer":null,"choice":null,"score":null,"confidence":0,"grades":[{"choice":false,"confidence":0,"evidence":"Unsupported"},{"choice":"false","confidence":1,"evidence":"Supported"}]});
    for mutation in 0..8 {
        let mut invalid = valid.clone();
        match mutation {
            0 => invalid["choice"] = json!(false),
            1 => invalid["grades"] = json!([valid["grades"][0]]),
            2 => invalid["grades"][1] = invalid["grades"][0].clone(),
            3 => invalid["grades"][1]["choice"] = json!("unlisted"),
            4 => invalid["grades"][1]["confidence"] = json!(1.01),
            5 => invalid["grades"][1]["evidence"] = json!("   "),
            6 => invalid["grades"][1]["evidence"] = json!("e".repeat(501)),
            _ => invalid["grades"]
                .as_array_mut()
                .unwrap()
                .push(json!({"choice":"extra","confidence":0,"evidence":"Extra"})),
        }
        let text = document(json!([invalid]));
        let mut world =
            World::new(Mode::Anthropic, 16384, vec![stream(&text), stream(&text)]).await;
        assert_error(
            bounded(world.evaluate(&input, &Cancellation::default())).await,
            "InvalidOutput",
        );
        world.assert_settled(2);
        world.stop().await;
    }
}

#[tokio::test]
async fn malformed_json_and_toon_recover_once_without_rewriting_model_visible_prefixes() {
    let toon = decision::toon::encode(
        &parse_json(&document(json!([
            serde_json::from_str::<Value>(ANSWER).unwrap()
        ])))
        .unwrap(),
    );
    for malformed in ["{not-json".to_owned(), toon] {
        let mut world = World::new(Mode::Anthropic, 16384, vec![stream(&malformed), valid()]).await;
        let response =
            bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
                .await
                .unwrap();
        assert_eq!(
            value(&response)["response"]["usage"],
            json!({"input":22,"output":14,"reasoning":0,"cache":{"read":6,"write":4}})
        );
        let seen = world.seen();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], seen[1]);
        assert_eq!(seen[0]["max_tokens"], 4096);
        world.assert_settled(2);
        for record in world.ledger() {
            assert_eq!(
                value(record.tokens.value()),
                serde_json::from_str::<Value>(TOKENS).unwrap()
            );
            assert!((record.cost.unwrap() - 0.0000278).abs() < 1e-12);
            assert_eq!(record.cache_read_reported, Some(1));
        }
        world.stop().await;
    }
}

#[tokio::test]
async fn invalid_json_or_answers_exhaust_exactly_two_attempts() {
    let wrong = ANSWER.replace("\"answer\":true", "\"answer\":\"true\"");
    let duplicate = document(json!([
        serde_json::from_str::<Value>(ANSWER).unwrap(),
        serde_json::from_str::<Value>(ANSWER).unwrap()
    ]));
    for text in [
        "not JSON".to_owned(),
        document(json!([serde_json::from_str::<Value>(&wrong).unwrap()])),
        duplicate,
    ] {
        let mut world =
            World::new(Mode::Anthropic, 16384, vec![stream(&text), stream(&text)]).await;
        assert_error(
            bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await,
            "InvalidOutput",
        );
        world.assert_settled(2);
        world.stop().await;
    }
}

#[tokio::test]
async fn truncation_expands_only_the_token_limit_within_the_model_ceiling() {
    for (limit, expected) in [(16384, 8192), (6000, 6000), (2048, 4096)] {
        let mut world = World::new(
            Mode::Anthropic,
            limit,
            vec![
                Reply::Stream {
                    text: "{".into(),
                    finish: Some("max_tokens"),
                    usage: true,
                },
                valid(),
            ],
        )
        .await;
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
            .await
            .unwrap();
        let seen = world.seen();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0]["max_tokens"], 4096);
        assert_eq!(seen[1]["max_tokens"], expected);
        let mut original = seen[0].clone();
        original["max_tokens"] = json!(expected);
        assert_eq!(seen[1], original);
        world.assert_settled(2);
        world.stop().await;
    }
}

#[tokio::test]
async fn missing_terminal_provider_output_recovers_without_token_expansion() {
    let mut world = World::new(
        Mode::Anthropic,
        16384,
        vec![
            Reply::Stream {
                text: "{".into(),
                finish: None,
                usage: false,
            },
            valid(),
        ],
    )
    .await;
    bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
        .await
        .unwrap();
    assert_eq!(world.seen()[1]["max_tokens"], 4096);
    world.assert_settled(2);
    world.stop().await;
}

#[tokio::test]
async fn truncation_exhaustion_retains_its_typed_reason() {
    let mut world = World::new(
        Mode::Anthropic,
        16384,
        vec![
            Reply::Stream {
                text: "{".into(),
                finish: Some("max_tokens"),
                usage: true,
            },
            Reply::Stream {
                text: "{".into(),
                finish: Some("max_tokens"),
                usage: true,
            },
        ],
    )
    .await;
    assert_error(
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await,
        "TruncatedOutput",
    );
    let seen = world.seen();
    assert_eq!(seen[1]["max_tokens"], 8192);
    world.assert_settled(2);
    world.stop().await;
}

#[tokio::test]
async fn typed_refusal_is_a_success_without_a_recovery_attempt() {
    let refusal = json!({"name":"safe","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0});
    let mut world = World::new(
        Mode::Anthropic,
        16384,
        vec![stream(&document(json!([refusal])))],
    )
    .await;
    let result = bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
        .await
        .unwrap();
    assert_eq!(value(&result)["response"]["answers"], json!([refusal]));
    world.assert_settled(1);
    world.stop().await;
}

#[tokio::test]
async fn provider_refusal_auth_quota_rate_limit_and_bad_requests_are_not_retried() {
    for (reply, reason) in [
        (
            Reply::Stream {
                text: String::new(),
                finish: Some("refusal"),
                usage: false,
            },
            "Refused",
        ),
        (
            Reply::Http(400, r#"{"error":{"message":"content policy rejected"}}"#),
            "Refused",
        ),
        (
            Reply::Http(
                401,
                r#"{"error":{"type":"authentication_error","message":"synthetic rejection"}}"#,
            ),
            "ProviderFailed",
        ),
        (
            Reply::Http(
                429,
                r#"{"error":{"code":"insufficient_quota","message":"synthetic rejection"}}"#,
            ),
            "ProviderFailed",
        ),
        (
            Reply::Http(
                429,
                r#"{"error":{"code":"rate_limit_exceeded","message":"synthetic rejection"}}"#,
            ),
            "ProviderFailed",
        ),
        (
            Reply::Http(
                400,
                r#"{"error":{"type":"invalid_request_error","message":"synthetic rejection"}}"#,
            ),
            "ProviderFailed",
        ),
        (
            Reply::Http(
                400,
                r#"{"error":{"type":"internal_error","message":"synthetic rejection"}}"#,
            ),
            "ProviderFailed",
        ),
    ] {
        let mut world = World::new(Mode::Anthropic, 16384, vec![reply]).await;
        assert_error(
            bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await,
            reason,
        );
        world.assert_settled(1);
        assert!(world.ledger()[0].cost.is_none());
        world.stop().await;
    }
}

#[tokio::test]
async fn transport_and_server_internal_failures_recover_on_one_new_request() {
    for reply in [
        Reply::Disconnect,
        Reply::ProviderError,
        Reply::Http(
            503,
            r#"{"error":{"type":"internal_error","message":"synthetic failure"}}"#,
        ),
    ] {
        let mut world = World::new(Mode::Anthropic, 16384, vec![reply, valid()]).await;
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
            .await
            .unwrap();
        world.assert_settled(2);
        let records = world.ledger();
        assert!(records[0].cost.is_none());
        assert_eq!(
            value(records[1].tokens.value()),
            serde_json::from_str::<Value>(TOKENS).unwrap()
        );
        world.stop().await;
    }
}

#[tokio::test]
async fn unexpected_tool_output_is_rejected_and_recovered_without_executing_tools() {
    let mut world = World::new(Mode::Anthropic, 16384, vec![Reply::ToolCall, valid()]).await;
    let result = bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
        .await
        .unwrap();
    assert_eq!(
        value(&result)["response"]["answers"],
        json!([serde_json::from_str::<Value>(ANSWER).unwrap()])
    );
    let seen = world.seen();
    assert_eq!(seen[0], seen[1]);
    assert!(seen[0].get("tools").is_none());
    world.assert_settled(2);
    world.stop().await;
}

#[tokio::test]
async fn unverified_compatible_route_has_no_physical_or_durable_request() {
    let mut world = World::new(Mode::Compatible, 16384, vec![valid()]).await;
    assert_error(
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await,
        "UnsupportedOutput",
    );
    world.assert_settled(0);
    world.stop().await;
}

#[tokio::test]
async fn missing_usage_stays_absent_and_reported_usage_is_not_reconstructed() {
    for first in [false, true] {
        let mut world = World::new(
            Mode::Anthropic,
            16384,
            vec![
                Reply::Stream {
                    text: "{".into(),
                    finish: Some("end_turn"),
                    usage: first,
                },
                Reply::Stream {
                    text: document(json!([serde_json::from_str::<Value>(ANSWER).unwrap()])),
                    finish: Some("end_turn"),
                    usage: false,
                },
            ],
        )
        .await;
        let result = bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()))
            .await
            .unwrap();
        let response = value(&result);
        if first {
            assert_eq!(
                response["response"]["usage"],
                serde_json::from_str::<Value>(TOKENS).unwrap()
            );
        } else {
            assert!(response["response"].get("usage").is_none());
        }
        world.assert_settled(2);
        let records = world.ledger();
        assert!(records[1].cost.is_none());
        assert_eq!(records[1].cache_read_reported, Some(0));
        world.stop().await;
    }
}

#[tokio::test]
async fn exact_utf8_input_and_output_byte_limits_are_accepted() {
    let text = document(json!([serde_json::from_str::<Value>(ANSWER).unwrap()]));
    let remaining = BYTE_LIMIT - text.len();
    let text = format!("{text}{}", " ".repeat(remaining));
    assert_eq!(text.len(), BYTE_LIMIT);
    let mut input = serde_json::from_str::<Value>(INPUT).unwrap();
    input["request"]["state"] = json!("");
    let remaining = BYTE_LIMIT - input.to_string().len();
    input["request"]["state"] = json!(format!(
        "{}{}",
        "é".repeat(remaining / 2),
        " ".repeat(remaining % 2)
    ));
    assert_eq!(input.to_string().len(), BYTE_LIMIT);
    let mut world = World::new(Mode::Anthropic, 16384, vec![stream(&text)]).await;
    bounded(world.evaluate(
        &parse_json(&input.to_string()).unwrap(),
        &Cancellation::default(),
    ))
    .await
    .unwrap();
    world.assert_settled(1);
    world.stop().await;
}

#[tokio::test]
async fn byte_limits_are_utf8_exact_and_oversized_output_is_not_retried() {
    let mut world = World::new(
        Mode::Anthropic,
        16384,
        vec![Reply::Stream {
            text: "é".repeat(BYTE_LIMIT / 2 + 1),
            finish: Some("end_turn"),
            usage: false,
        }],
    )
    .await;
    assert_error(
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await,
        "InvalidOutput",
    );
    world.assert_settled(1);
    world.stop().await;
    let mut input = serde_json::from_str::<Value>(INPUT).unwrap();
    input["request"]["state"] = json!("é".repeat(BYTE_LIMIT / 2));
    let mut world = World::new(Mode::Anthropic, 16384, vec![]).await;
    assert_error(
        bounded(world.evaluate(
            &parse_json(&input.to_string()).unwrap(),
            &Cancellation::default(),
        ))
        .await,
        "InputTooLarge",
    );
    world.assert_settled(0);
    assert_error(
        bounded(world.evaluate(
            &parse_json(r#"{"provider":"agent","request":{"state":{},"questions":[]}}"#).unwrap(),
            &Cancellation::default(),
        ))
        .await,
        "InvalidRequest",
    );
    world.assert_settled(0);
    world.stop().await;
}

#[tokio::test]
async fn an_unavailable_decision_agent_dispatches_nothing() {
    let mut world = World::new(Mode::Anthropic, 16384, vec![]).await;
    world.decision.agents = Arc::new(agent::Service::new(vec![]));
    assert_error(
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default())).await,
        "Unavailable",
    );
    world.assert_settled(0);
    world.stop().await;
}

#[tokio::test]
async fn cancellation_before_dispatch_or_during_a_request_never_recovers() {
    let mut world = World::new(Mode::Anthropic, 16384, vec![Reply::Hold]).await;
    let cancellation = Cancellation::default();
    cancellation.cancel();
    assert_error(
        bounded(world.evaluate(&parse_json(INPUT).unwrap(), &cancellation)).await,
        "Cancelled",
    );
    world.assert_settled(0);
    let cancellation = Cancellation::default();
    let input = parse_json(INPUT).unwrap();
    let result = {
        let evaluation = world.evaluate(&input, &cancellation);
        tokio::pin!(evaluation);
        bounded(async {
            tokio::select! {
                result = &mut evaluation => panic!("request settled before cancellation: {result:?}"),
                _ = world.provider.arrived.notified() => {},
            }
        }).await;
        cancellation.cancel();
        bounded(evaluation).await
    };
    assert_error(result, "Cancelled");
    world.assert_settled(1);
    world.stop().await;
}

#[tokio::test]
async fn two_twenty_five_second_attempts_settle_within_the_sixty_second_budget() {
    let mut world = World::new(Mode::Anthropic, 16384, vec![Reply::Hold, Reply::Hold]).await;
    let started = tokio::time::Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(55),
        world.evaluate(&parse_json(INPUT).unwrap(), &Cancellation::default()),
    )
    .await
    .expect("decision exceeded its two-attempt deadline");
    assert_error(result, "Timeout");
    assert!(started.elapsed() >= Duration::from_secs(50));
    world.assert_settled(2);
    world.stop().await;
}
