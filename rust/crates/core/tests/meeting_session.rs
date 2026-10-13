use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use ycoding_core::{
    meeting::{
        ask::Questions,
        config::MeetingConfig,
        intelligence::{self, Intelligence, Mcp, ServiceMcp, Settings},
        runtime::{MeetingRuntime, RuntimeOptions, SessionFactory},
        service::{MeetingService, ServiceOptions},
        store::MeetingDatabase,
    },
    resources::{
        attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        analysis::{Analysis, Generator, SYSTEM, analysis_agent},
        run_coordinator::Coordinator,
        runner::{Local, Services, WallClock},
        store::Service as SessionStore,
    },
    tools::registry::Registry,
};
use ycoding_schema::{DomainDecode, parse_json, project, session};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
mod support;

static NEXT: AtomicU64 = AtomicU64::new(0);

async fn bounded<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(25), work)
        .await
        .expect("session seam test exceeded 25 seconds")
}

fn scratch(prefix: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ycoding-meeting-session-{}-{}-{}",
        prefix,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn sse(content: &str) -> String {
    let first = json!({"id":"reply","choices":[{"index":0,"delta":{"content":content},"finish_reason":null}]})
        .to_string();
    let last = json!({"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}).to_string();
    format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n")
}

async fn loopback(
    replies: Vec<String>,
) -> (
    String,
    mpsc::UnboundedReceiver<ycoding_schema::JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for reply in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break boundary + 4;
                }
            };
            let header = std::str::from_utf8(&request[..boundary]).unwrap();
            let length = header
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
            let body =
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap();
            send.send(body).unwrap();
            let response = format!(
                "HTTP/1.1 200 Response\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, receive, task)
}

fn registry() -> Arc<Registry> {
    Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-meeting-session-output"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ))
}

fn local(
    store: &ycoding_store::Store,
    endpoint: &str,
    registry: Arc<Registry>,
    analysis: Arc<Analysis>,
) -> Local {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    Local::new(Services {
        store: SessionStore::new(store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(ycoding_core::resources::agent::Service::new(vec![
            analysis_agent(),
        ])),
        credentials: credential::Service::new(store.client()),
        tools: registry,
        attachments: Arc::new(
            attachment_store::Store::new(std::env::temp_dir().join("ycoding-session-attachments"))
                .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: Some(analysis),
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
        skill_resolver: None,
        claude: None,
        auth: None,
    })
}

struct Seam {
    generator: Arc<Generator>,
    coordinator: Coordinator,
    task: tokio::task::JoinHandle<()>,
}

async fn seam(
    store: &ycoding_store::Store,
    replies: Vec<String>,
) -> (Seam, mpsc::UnboundedReceiver<ycoding_schema::JsonValue>) {
    let analysis = Analysis::new(32_000);
    let (endpoint, requests, task) = loopback(replies).await;
    let coordinator = Coordinator::new(Arc::new(local(
        store,
        &endpoint,
        registry(),
        analysis.clone(),
    )));
    let location =
        ycoding_schema::location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap())
            .unwrap();
    let generator = Arc::new(Generator::new(
        SessionStore::new(store.client()),
        coordinator.clone(),
        analysis,
        location,
        project::Id::new("prj_one").unwrap(),
        None,
    ));
    (
        Seam {
            generator,
            coordinator,
            task,
        },
        requests,
    )
}

fn segment(id: &str, sequence: i64, text: &str) -> Value {
    json!({
        "id": id, "meetingID": "meeting", "sequence": sequence, "source": "remote",
        "speakerID": "remote-unknown", "startMs": sequence * 1000, "endMs": sequence * 1000 + 900,
        "rawText": text, "text": text, "state": "final", "model": "test-model",
        "createdAt": "2026-10-12T00:00:00.000Z",
    })
}

fn body(value: &ycoding_schema::JsonValue) -> Value {
    serde_json::from_str(&ycoding_schema::stringify_json(value)).unwrap()
}

fn extraction(summary: &str) -> String {
    json!({"summary": summary, "findings": [], "proposals": []}).to_string()
}

#[tokio::test]
async fn session_backed_summary_sends_the_analysis_prompt_as_one_tool_free_request() {
    bounded(async {
        let root = scratch("summary");
        let store = support::store();
        let (seam, mut requests) =
            seam(&store, vec![sse(&extraction("Discussed authentication"))]).await;
        let session = seam.generator.create_session(None).await.unwrap();
        let database = MeetingDatabase::open(&root.join("meetings.redb")).unwrap();
        database
            .create_meeting("meeting", "Meeting", &session)
            .await
            .unwrap();
        database
            .put_segment(&segment("seg-1", 1, "We should refactor authentication"))
            .await
            .unwrap();
        let intelligence = Intelligence::new(
            database.clone(),
            Some(intelligence::from_generator(seam.generator.clone())),
            None,
            Settings {
                bindings: Vec::new(),
                max_characters: 32_000,
                retrieval_ttl: Duration::from_secs(300),
            },
        );
        intelligence
            .analyze("meeting", true, false)
            .wait()
            .await
            .unwrap();
        let request = body(&requests.recv().await.unwrap());
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], SYSTEM);
        assert_eq!(messages[1]["role"], "user");
        assert!(
            messages[1]["content"]
                .as_str()
                .unwrap()
                .contains("We should refactor authentication")
        );
        assert!(request.get("tools").is_none());
        let checkpoint = database.checkpoints("meeting").unwrap().pop().unwrap();
        assert_eq!(checkpoint["summary"], "Discussed authentication");
        assert_eq!(checkpoint["final"], true);
        database.close().await.unwrap();
        seam.task.await.unwrap();
        seam.coordinator.shutdown().await.unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    })
    .await;
}

#[tokio::test]
async fn session_backed_ask_answers_from_transcript_in_a_registered_session() {
    bounded(async {
        let root = scratch("ask");
        let store = support::store();
        let (seam, mut requests) = seam(&store, vec![sse("Friday, citing seg-1")]).await;
        let database = MeetingDatabase::open(&root.join("meetings.redb")).unwrap();
        let factory: SessionFactory = {
            let generator = seam.generator.clone();
            Arc::new(move |parent: Option<String>| {
                let generator = generator.clone();
                Box::pin(async move { generator.create_session(parent.as_deref()).await })
                    as ycoding_core::meeting::BoxFuture<'static, Result<String, String>>
            })
        };
        let runtime = MeetingRuntime::new(RuntimeOptions {
            directory: root.clone(),
            database: database.clone(),
            config: MeetingConfig::parse(&json!({})).unwrap(),
            create_session: factory,
            provider_factory: None,
            heartbeat_timeout: Duration::from_secs(15),
            generate: Some(intelligence::from_generator(seam.generator.clone())),
            mcp: None,
        })
        .await
        .unwrap();
        let meeting = seam.generator.create_session(None).await.unwrap();
        database
            .create_meeting("meeting", "Meeting", &meeting)
            .await
            .unwrap();
        runtime
            .control(json!({"action": "select", "meetingID": "meeting"}))
            .await
            .unwrap();
        database
            .put_segment(&segment("seg-1", 1, "Ship on Friday"))
            .await
            .unwrap();
        let questions = Questions::with_generator(runtime, seam.generator.clone());
        let entry = questions.ask("What was decided?".into()).await;
        assert_eq!(entry["status"], "answered");
        assert_eq!(entry["answer"], "Friday, citing seg-1");
        let request = body(&requests.recv().await.unwrap());
        let messages = request["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], SYSTEM);
        assert!(
            messages[1]["content"]
                .as_str()
                .unwrap()
                .contains("What was decided?")
        );
        assert!(request.get("tools").is_none());
        database.close().await.unwrap();
        seam.task.await.unwrap();
        seam.coordinator.shutdown().await.unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    })
    .await;
}

#[tokio::test]
async fn service_start_registers_persisted_analysis_sessions() {
    bounded(async {
        let root = scratch("register");
        let database = MeetingDatabase::open(&root.join("meetings.redb")).unwrap();
        database
            .create_meeting("meeting", "Meeting", "ses_persisted1")
            .await
            .unwrap();
        database.close().await.unwrap();
        let analysis = Analysis::new(32_000);
        let mut options = ServiceOptions::new(
            root.clone(),
            MeetingConfig::parse(&json!({})).unwrap(),
            Arc::new(|_| Box::pin(async { Ok("ses_runtime".to_owned()) })),
        );
        options.analysis = Some(analysis.clone());
        let service = MeetingService::start(options).await.unwrap();
        assert!(analysis.contains(&session::Id::new("ses_persisted1").unwrap()));
        service.shutdown().await.unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    })
    .await;
}

#[tokio::test]
async fn service_mcp_constructor_adapts_the_live_core_service() {
    bounded(async {
        let root = scratch("mcp");
        let service = ycoding_core::resources::mcp::Service::new(
            &[],
            root.clone(),
            "1".into(),
            BTreeMap::new(),
            ycoding_core::resources::mcp::client::Hooks::default(),
        )
        .unwrap();
        let mcp = Arc::new(ServiceMcp::new(service));
        assert!(mcp.tools().await.unwrap().is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    })
    .await;
}

#[tokio::test]
async fn analysis_prompts_commit_a_staged_revert_before_running() {
    bounded(async {
        let store = support::store();
        let (seam, mut requests) =
            seam(&store, vec![sse("first answer"), sse("second answer")]).await;
        let sessions = SessionStore::new(store.client());
        let session = seam.generator.create_session(None).await.unwrap();
        assert_eq!(
            seam.generator
                .generate(&session, "first question")
                .await
                .unwrap(),
            "first answer"
        );
        let id = session::Id::new(session.as_str()).unwrap();
        let first_user = sessions
            .context(&id)
            .unwrap()
            .into_iter()
            .find_map(|message| match message {
                ycoding_schema::session_message::Info::User(user) => Some(user.id),
                _ => None,
            })
            .unwrap();
        sessions
            .publish(ycoding_store::session::NewEvent {
                id: "evt_stage_analysis".into(),
                aggregate_id: id.as_lossless().clone(),
                created: chrono::Utc::now().timestamp_millis(),
                type_: "session.revert.staged.1".into(),
                data: parse_json(&format!(
                    r#"{{"sessionID":"{session}","revert":{{"messageID":"{}","files":[]}}}}"#,
                    first_user.as_lossless().to_utf8().unwrap()
                ))
                .unwrap(),
            })
            .await
            .unwrap();
        assert!(sessions.get(&id).unwrap().unwrap().revert.is_some());

        assert_eq!(
            seam.generator
                .generate(&session, "second question")
                .await
                .unwrap(),
            "second answer"
        );

        assert!(sessions.get(&id).unwrap().unwrap().revert.is_none());
        requests.recv().await.unwrap();
        let second = body(&requests.recv().await.unwrap());
        let messages = second["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert!(
            messages[1]["content"]
                .as_str()
                .unwrap()
                .contains("second question")
        );
        seam.task.await.unwrap();
        seam.coordinator.shutdown().await.unwrap();
    })
    .await;
}
