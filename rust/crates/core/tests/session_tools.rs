include!("tool_fixture.rs");
use std::{
    collections::BTreeMap,
    ops::Bound,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
    task::JoinHandle,
};
use ycoding_ai::{llm, route::Executor};
use ycoding_core::{
    job,
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        config::{Configuration, LoadOptions, Roots},
        credential,
        decision::{self, judgment::Request},
        model,
    },
    session::{
        autonomy::{self, Goal, YoloLevel},
        generate, image_analyzer,
        orchestration::{self, Preflight},
        pending,
        run_coordinator::{self, Coordinator, Outcome, RunFuture},
        runner::{Local, Services, WallClock},
        store, title,
    },
    tools::{
        builtin::{
            conversation_compact::{self, Advisor},
            subagent::{self, Subagent},
        },
        code_mode::Cancellation,
        context::{
            Context,
            consumers::{SessionDependencies, SessionTools},
        },
        materialization::Settlement,
        policy::{
            forms::Forms,
            helper::{self, Models, TitleMode},
        },
        registry::{Options, Registration, Registry},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, ObjectEncoder, form, parse_json,
    session, session_compaction, session_message, session_pending,
};
use ycoding_store::{
    KeyPart,
    resources::RequestTable,
    session::{EventTable, SessionTable, TodoStateTable},
    tuple_key,
};

#[derive(Clone)]
enum Reply {
    Text(String),
    Rejected,
    Unsettled(String),
    Tool(String),
    Completion,
    NoUsage(String),
}
struct Server {
    url: String,
    seen: Arc<Mutex<Vec<JsonValue>>>,
    reply: Arc<Mutex<Reply>>,
    gate: Arc<Mutex<Option<Arc<Notify>>>>,
    entered: Arc<Notify>,
    task: JoinHandle<()>,
}
impl Server {
    async fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let reply = Arc::new(Mutex::new(Reply::Text("Verified response".into())));
        let gate = Arc::new(Mutex::new(None::<Arc<Notify>>));
        let entered = Arc::new(Notify::new());
        let shared = (seen.clone(), reply.clone(), gate.clone(), entered.clone());
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut stream, _) = accepted.unwrap(); let shared = shared.clone();
                        connections.spawn(async move {
                            let mut buffer = [0;4096]; let mut raw = Vec::new();
                            let boundary = loop {let read = stream.read(&mut buffer).await.unwrap(); if read == 0 {return;} raw.extend_from_slice(&buffer[..read]); if let Some(boundary) = raw.windows(4).position(|bytes| bytes == b"\r\n\r\n") {break boundary+4;}};
                            let length = std::str::from_utf8(&raw[..boundary]).unwrap().lines().find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())).unwrap();
                            while raw.len()-boundary < length {let read = stream.read(&mut buffer).await.unwrap(); if read == 0 {return;} raw.extend_from_slice(&buffer[..read]);}
                            let body = std::str::from_utf8(&raw[boundary..boundary+length]).unwrap();
                            let request = parse_json(body).unwrap_or_else(|_| JsonValue::String(body.into()));
                            shared.0.lock().unwrap().push(request.clone()); shared.3.notify_one();
                            let gate = shared.2.lock().unwrap().clone();
                            if let Some(gate) = gate {tokio::select! {_ = gate.notified() => {}, _ = stream.read(&mut buffer) => return}}
                            let reply = shared.1.lock().unwrap().clone();
                            let quote = |text: &str| ycoding_schema::stringify_json(&JsonValue::String(text.into()));
                            let terminal = |usage: bool| format!("data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]{} }}\n\ndata: [DONE]\n\n", if usage {",\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":7,\"completion_tokens_details\":{\"reasoning_tokens\":2},\"prompt_tokens_details\":{\"cached_tokens\":4}}"} else {""});
                            let text = |text: &str| format!("data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\n", quote(text));
                            let tool = |name: &str| format!("data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"call_done\",\"type\":\"function\",\"function\":{{\"name\":{},\"arguments\":\"{{}}\"}}}}]}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n", quote(name));
                            let (status, mime, body) = match reply {
                                Reply::Text(value) => (200, "text/event-stream", format!("{}{}", text(&value), terminal(true))),
                                Reply::NoUsage(value) => (200, "text/event-stream", format!("{}{}", text(&value), terminal(false))),
                                Reply::Unsettled(value) => (200, "text/event-stream", text(&value)),
                                Reply::Rejected => (400, "application/json", r#"{"error":{"message":"rejected"}}"#.into()),
                                Reply::Tool(name) => (200, "text/event-stream", tool(&name)),
                                Reply::Completion => (200, "text/event-stream", if ycoding_schema::stringify_json(&request).contains("Completion declaration recorded") {format!("{}{}", text("Completed and verified."), terminal(true))} else {tool("task_complete")}),
                            };
                            let response = format!("HTTP/1.1 {status} Response\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = stream.write_all(response.as_bytes()).await;
                        });
                    }
                    _ = connections.join_next(), if !connections.is_empty() => {}
                }
            }
        });
        Self {
            url,
            seen,
            reply,
            gate,
            entered,
            task,
        }
    }
    fn set(&self, reply: Reply) {
        *self.reply.lock().unwrap() = reply;
    }
    fn hold(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.gate.lock().unwrap() = Some(gate.clone());
        gate
    }
    async fn entered(&self) {
        within(self.entered.notified()).await;
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("operation exceeded 30 seconds")
}

#[derive(Clone)]
struct Execution {
    coordinator: Coordinator,
    interrupted: Arc<Mutex<Vec<session::Id>>>,
}
impl orchestration::Execution for Execution {
    fn wake(&self, id: &session::Id) -> Outcome {
        self.coordinator.wake(id)
    }
    fn interrupt(&self, id: &session::Id) -> RunFuture {
        subagent::Execution::interrupt(self, id.clone())
    }
}
impl subagent::Execution for Execution {
    fn resume(&self, id: session::Id) -> RunFuture {
        let coordinator = self.coordinator.clone();
        Box::pin(async move { coordinator.run(&id).await })
    }
    fn interrupt(&self, id: session::Id) -> RunFuture {
        self.interrupted.lock().unwrap().push(id.clone());
        let coordinator = self.coordinator.clone();
        Box::pin(async move {
            coordinator
                .interrupt(&id, run_coordinator::InterruptReason::User)
                .await
        })
    }
    fn request_interrupt(&self, id: &session::Id) -> Outcome {
        self.interrupted.lock().unwrap().push(id.clone());
        self.coordinator
            .request_interrupt(id, run_coordinator::InterruptReason::User)
    }
}

struct Harness {
    fixture: ToolFixture,
    server: Server,
    store: store::Service,
    registry: Arc<Registry>,
    registration: Registration,
    tools: SessionTools,
    forms: Forms,
    models: Arc<Models>,
    agents: Arc<agent::Service>,
    executor: Arc<Executor>,
    execution: Arc<Execution>,
    orchestration: Arc<orchestration::Service>,
    jobs: job::Jobs,
    attachments: Arc<attachment_store::Store>,
    config: Arc<Configuration>,
    activations: Arc<Mutex<Vec<LosslessString>>>,
}
impl Harness {
    async fn new(title_mode: TitleMode, config: &str) -> Self {
        let fixture = ToolFixture::new();
        let server = Server::new().await;
        let mut source = parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap();
        let JsonValue::Object(providers) = &mut source else {
            panic!()
        };
        let JsonValue::Object(mut provider) = providers.get(&"openai".into()).unwrap().clone()
        else {
            panic!()
        };
        let JsonValue::Object(mut models) = provider.get(&"models".into()).unwrap().clone() else {
            panic!()
        };
        let JsonValue::Object(mut model) = models.get(&"gpt-reasoning".into()).unwrap().clone()
        else {
            panic!()
        };
        model.insert(
            "cost".into(),
            parse_json(r#"{"input":1,"output":2,"cache_read":0.1,"cache_write":0.5}"#).unwrap(),
        );
        models.insert("gpt-reasoning".into(), JsonValue::Object(model));
        provider.insert("models".into(), JsonValue::Object(models));
        providers.insert("openai".into(), JsonValue::Object(provider));
        let mut catalog = Catalog::new(models_dev::normalize(&source).unwrap());
        catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{}"}}}}}}}}"#, server.url)).unwrap()]).unwrap();
        let resolver = Arc::new(model::Resolver::new(catalog));
        let credentials = credential::Service::new(fixture.authority.store.client());
        let store = store::Service::new(fixture.authority.store.client());
        let directory = fixture.root.to_string_lossy().into_owned();
        fixture
            .authority
            .store
            .submit(move |tx| {
                let key = tuple_key(&[KeyPart::String(&"ses_tool".into())]);
                let mut row = tx.get::<SessionTable>(&key)?.unwrap();
                row.directory = directory.into();
                row.model = Some(ycoding_store::session::Document::new(
                    parse_json(r#"{"providerID":"openai","id":"gpt-reasoning"}"#).unwrap(),
                )?);
                SessionTable::put(tx, &row)
            })
            .unwrap()
            .await
            .unwrap();
        let mut tester = agent::empty("test".into());
        tester.system = Some("Initial context".into());
        tester.permissions.push(
            ycoding_schema::permission::Rule::decode(
                &parse_json(r#"{"action":"question","resource":"*","effect":"deny"}"#).unwrap(),
            )
            .unwrap(),
        );
        let mut explore = agent::empty("explore".into());
        explore.mode = "subagent".into();
        explore.permissions.push(
            ycoding_schema::permission::Rule::decode(
                &parse_json(r#"{"action":"subagent","resource":"*","effect":"deny"}"#).unwrap(),
            )
            .unwrap(),
        );
        let mut title_agent = agent::empty("title".into());
        title_agent.hidden = true;
        title_agent.system = Some("Generate one title".into());
        let mut decision_agent = agent::empty("decision".into());
        decision_agent.hidden = true;
        decision_agent.system = Some(agent::prompts::DECISION.into());
        let agents = Arc::new(agent::Service::new(vec![
            tester,
            explore,
            title_agent,
            decision_agent,
        ]));
        let config = Arc::new(
            Configuration::load(LoadOptions {
                directory: fixture.root.clone(),
                roots: Roots::development(&fixture.root).unwrap(),
                project: false,
                file: None,
                content: Some(config.into()),
                env: BTreeMap::new(),
            })
            .unwrap(),
        );
        assert!(config.diagnostics.is_empty(), "{:?}", config.diagnostics);
        let models = Arc::new(Models {
            models: resolver.clone(),
            credentials: credentials.clone(),
            auth: Default::default(),
            cursor: None,
            claude: None,
            store: store.clone(),
            settings: helper::Settings {
                title_mode,
                ..Default::default()
            },
        });
        let executor = Arc::new(Executor::new(Executor::http_client().unwrap()));
        let registry = Arc::new(fixture.registry());
        let attachments =
            Arc::new(attachment_store::Store::new(fixture.root.join("attachments")).unwrap());
        let local = Local::new(Services {
            store: store.clone(),
            location: store
                .get(&session::Id::new("ses_tool").unwrap())
                .unwrap()
                .unwrap()
                .location,
            models: resolver.clone(),
            agents: agents.clone(),
            credentials: credentials.clone(),
            tools: registry.clone(),
            attachments: attachments.clone(),
            instructions: vec![],
            analysis: None,
            clock: Arc::new(WallClock),
            executor: executor.clone(),
            compaction: Default::default(),
            guardrails: fixture.policy.guardrails.clone(),
            helpers: helper::Settings::default(),
            cursor: None,
            claude: None,
            auth: None,
            skill_resolver: None,
        });
        let execution = Arc::new(Execution {
            coordinator: Coordinator::new(Arc::new(local)),
            interrupted: Arc::default(),
        });
        let orchestration = Arc::new(orchestration::Service::new(
            store.clone(),
            execution.clone(),
        ));
        let jobs = job::Jobs::new();
        let forms = Forms::new(fixture.authority.authority(), fixture.authority.publisher());
        let activations = Arc::new(Mutex::new(Vec::new()));
        let activated = activations.clone();
        let tools = SessionTools::new(SessionDependencies {
            subagent: Subagent {
                store: store.clone(),
                orchestration: orchestration.clone(),
                preflight: Preflight::new(store.clone(), agents.clone(), resolver, credentials),
                execution: execution.clone(),
                policy: fixture.policy.clone(),
                jobs: jobs.clone(),
                agents: agents.clone(),
                config: config.clone(),
                collator: Arc::new(|left, right| left.cmp(right)),
                activate: Arc::new(move |_, agent| {
                    activated.lock().unwrap().push(agent);
                    Box::pin(async {})
                }),
            },
            forms: forms.clone(),
            decisions: Arc::new(decision::Service {
                store: store.clone(),
                agents: agents.clone(),
                models: models.clone(),
                executor: executor.clone(),
            }),
            publish: fixture.authority.publisher(),
            compaction: Default::default(),
        });
        let registration = registry
            .register(tools.clone().entries(), Options::direct())
            .unwrap();
        Self {
            fixture,
            server,
            store,
            registry,
            registration,
            tools,
            forms,
            models,
            agents,
            executor,
            execution,
            orchestration,
            jobs,
            attachments,
            config,
            activations,
        }
    }
    fn context(&self) -> Context {
        self.fixture.context()
    }
    fn subagent(&self, policy: Arc<ycoding_core::tools::context::policy::LeafPolicy>) -> Subagent {
        let activated = self.activations.clone();
        Subagent {
            store: self.store.clone(),
            orchestration: self.orchestration.clone(),
            preflight: Preflight::new(
                self.store.clone(),
                self.agents.clone(),
                self.models.models.clone(),
                self.models.credentials.clone(),
            ),
            execution: self.execution.clone(),
            policy,
            jobs: self.jobs.clone(),
            agents: self.agents.clone(),
            config: self.config.clone(),
            collator: Arc::new(|left, right| left.cmp(right)),
            activate: Arc::new(move |_, agent| {
                activated.lock().unwrap().push(agent);
                Box::pin(async {})
            }),
        }
    }
    async fn call(&self, name: &str, input: &str) -> Settlement {
        within(self.registry.materialize(&[]).invoke(
            name,
            parse_json(input).unwrap(),
            self.context(),
        ))
        .await
        .unwrap()
    }
    fn title(&self) -> title::Service {
        title::Service::new(
            self.store.clone(),
            self.agents.clone(),
            self.models.clone(),
            self.executor.clone(),
        )
    }
    fn image(&self) -> image_analyzer::Service {
        image_analyzer::Service::new(
            self.config.clone(),
            self.models.clone(),
            self.executor.clone(),
        )
    }
    fn generator(&self) -> generate::Service {
        generate::Service {
            store: self.store.clone(),
            location: self
                .store
                .get(&self.context().session_id)
                .unwrap()
                .unwrap()
                .location,
            agents: self.agents.clone(),
            models: self.models.clone(),
            executor: self.executor.clone(),
            attachments: self.attachments.clone(),
            instructions: vec![],
            extensions: vec![],
        }
    }
    fn events(&self) -> Vec<ycoding_store::session::Event> {
        self.fixture
            .authority
            .store
            .snapshot()
            .unwrap()
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .unwrap()
    }
    fn ledger(&self) -> Vec<ycoding_store::resources::Request> {
        self.fixture
            .authority
            .store
            .snapshot()
            .unwrap()
            .scan::<RequestTable>(Bound::Unbounded, Bound::Unbounded, usize::MAX)
            .unwrap()
    }
    async fn prompt(&self, text: &str, name: &str) {
        self.store
            .admit_input(pending::Request {
                id: session_message::Id::new(format!("msg_{name}")).unwrap(),
                session_id: self.context().session_id,
                input: session_pending::Message::decode(
                    &ObjectEncoder::new()
                        .field("type", "user")
                        .field("data", &ObjectEncoder::new().field("text", text).finish())
                        .field("delivery", "steer")
                        .finish(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new(format!("evt_{name}")).unwrap(),
                created: chrono::Utc::now().timestamp_millis(),
            })
            .await
            .unwrap();
        self.store
            .promote_steers(
                &self.context().session_id,
                chrono::Utc::now().timestamp_millis(),
            )
            .await
            .unwrap();
    }
    async fn close(self) {
        self.jobs.close();
        let _ = self.execution.coordinator.shutdown().await;
        drop(self.registration);
        self.fixture.cleanup();
    }
}
fn output(result: &Settlement) -> &JsonValue {
    &result
        .output
        .as_ref()
        .expect("tool did not succeed")
        .structured
}
fn get<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(value) = value else {
        panic!("not an object")
    };
    value.get(&key.into()).unwrap()
}
fn text(value: &JsonValue) -> String {
    let JsonValue::String(value) = value else {
        panic!("not text")
    };
    value.to_utf8().unwrap()
}
fn child(result: &Settlement) -> session::Id {
    session::Id::decode(get(output(result), "sessionID")).unwrap()
}
fn request() -> &'static str {
    r#"{"provider":"agent","request":{"state":{"action":"read"},"questions":[{"type":"choice","name":"route","instructions":"Choose based on evidence","choices":[{"value":"keep-current"},{"value":"review"}]}]}}"#
}
fn answer() -> &'static str {
    "decisions:\n  version: 1\n  answers[1]{name,type,answer,choice,score,confidence}:\n    route,choice,null,review,null,0.8"
}

#[tokio::test]
async fn registry_contracts_are_exact_ts_definitions_and_compaction_is_not_a_model_tool() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let definitions = h.registry.materialize(&[]).definitions;
    assert_eq!(definitions.len(), 8);
    for contract in [
        include_str!("../src/tools/builtin/subagent.tool.json"),
        include_str!("../src/tools/builtin/subagent-control.tool.json"),
        include_str!("../src/tools/builtin/subagent-report.tool.json"),
        include_str!("../src/tools/builtin/goal.tool.json"),
        include_str!("../src/tools/builtin/question.tool.json"),
        include_str!("../src/tools/builtin/decision.tool.json"),
        include_str!("../src/tools/builtin/todowrite.tool.json"),
        include_str!("../src/tools/builtin/task-complete.tool.json"),
    ] {
        let contract = parse_json(contract).unwrap();
        let name = text(get(&contract, "name"));
        let definition = definitions
            .iter()
            .find(|definition| definition.name.as_str() == Some(&name))
            .unwrap();
        assert_eq!(
            definition.description.encode(),
            *get(&contract, "description")
        );
        assert_eq!(
            ycoding_schema::stringify_json(&definition.input_schema),
            ycoding_schema::stringify_json(get(&contract, "inputSchema"))
        );
        assert_eq!(
            definition.output_schema.as_ref().unwrap(),
            get(&contract, "outputSchema")
        );
    }
    let mut definitions = definitions;
    h.tools.decorate(&h.context(), &mut definitions).unwrap();
    assert!(
        !definitions
            .iter()
            .any(|definition| definition.name.as_str() == Some("subagent_report"))
    );
    assert!(
        definitions
            .iter()
            .find(|definition| definition.name.as_str() == Some("subagent"))
            .unwrap()
            .description
            .to_utf8()
            .unwrap()
            .contains("Available subagents:")
    );
    assert!(
        !definitions
            .iter()
            .any(|definition| definition.name.as_str() == Some("conversation_compact"))
    );
    h.close().await;
}

#[tokio::test]
async fn todo_registry_denial_has_zero_effect_and_replacement_persists_order_digest_and_notice() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.fixture.deny("todowrite", "*");
    let input = r#"{"todos":[{"content":"second","status":"pending","priority":"low"},{"content":"first","status":"in_progress","priority":"high"}]}"#;
    assert!(h.call("todowrite", input).await.output.is_none());
    assert!(h.store.todos(&h.context().session_id).unwrap().is_empty());
    assert!(h.fixture.authority.events.lock().unwrap().is_empty());
    h.fixture.authority.rules.lock().unwrap().pop();
    assert_eq!(
        get(output(&h.call("todowrite", input).await), "todos"),
        get(&parse_json(input).unwrap(), "todos")
    );
    let todos = h.store.todos(&h.context().session_id).unwrap();
    assert_eq!(
        todos
            .iter()
            .map(|todo| todo.content.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["second", "first"]
    );
    let row = h
        .fixture
        .authority
        .store
        .snapshot()
        .unwrap()
        .get::<TodoStateTable>(&tuple_key(&[KeyPart::String(&"ses_tool".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(row.revision, 1);
    assert_eq!(
        row.digest.as_str(),
        Some("b1d409388d44fb1244d0f3ff45e08cff36bcf434e187f08182e49c64e829a16d")
    );
    h.call("todowrite", r#"{"todos":[]}"#).await;
    assert!(h.store.todos(&h.context().session_id).unwrap().is_empty());
    assert_eq!(
        h.fixture
            .authority
            .events
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.type_)
            .collect::<Vec<_>>(),
        ["todo.updated", "todo.updated"]
    );
    h.close().await;
}

#[tokio::test]
async fn goal_tool_preserves_user_objective_denial_budget_and_terminal_rules() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let autonomy = autonomy::Service::new(h.fixture.authority.store.client());
    assert!(
        h.call("goal", r#"{"action":"set","text":"Assistant objective"}"#)
            .await
            .output
            .is_none()
    );
    autonomy
        .set_goal(
            &h.context().session_id,
            Goal::new("User objective", Some("User request"), Some(2)),
        )
        .await
        .unwrap();
    let original = autonomy.get(&h.context().session_id).unwrap();
    h.call(
        "goal",
        r#"{"action":"update","text":"Replacement","maxNoProgress":9}"#,
    )
    .await;
    assert_eq!(autonomy.get(&h.context().session_id).unwrap(), original);
    h.fixture.deny("goal", "report");
    assert!(
        h.call("goal", r#"{"action":"report"}"#)
            .await
            .output
            .is_none()
    );
    assert_eq!(autonomy.get(&h.context().session_id).unwrap(), original);
    h.fixture.authority.rules.lock().unwrap().pop();
    assert!(
        h.call("goal", r#"{"action":"report"}"#)
            .await
            .output
            .is_some()
    );
    assert_eq!(
        autonomy
            .get(&h.context().session_id)
            .unwrap()
            .goal
            .unwrap()
            .no_progress,
        1
    );
    h.call("goal", r#"{"action":"report"}"#).await;
    assert_eq!(
        autonomy
            .get(&h.context().session_id)
            .unwrap()
            .goal
            .unwrap()
            .status,
        autonomy::GoalStatus::Exhausted
    );
    assert!(
        h.call("goal", r#"{"action":"report"}"#)
            .await
            .output
            .is_none()
    );
    assert!(
        h.call("goal", r#"{"action":"update","status":"active"}"#)
            .await
            .output
            .is_none()
    );
    autonomy
        .set_goal(
            &h.context().session_id,
            Goal::new("Replacement by user", None, None),
        )
        .await
        .unwrap();
    h.call("goal", r#"{"action":"complete"}"#).await;
    assert_eq!(
        autonomy
            .get(&h.context().session_id)
            .unwrap()
            .goal
            .unwrap()
            .status,
        autonomy::GoalStatus::Completed
    );
    h.call("goal", r#"{"action":"stop"}"#).await;
    assert_eq!(
        autonomy
            .get(&h.context().session_id)
            .unwrap()
            .goal
            .unwrap()
            .status,
        autonomy::GoalStatus::Stopped
    );
    h.close().await;
}

#[tokio::test]
async fn question_permission_denial_creates_no_form_or_model_request() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.fixture.deny("question", "*");
    assert!(
        h.call(
            "question",
            r#"{"questions":[{"header":"Review","question":"Continue?","options":[]}] }"#
        )
        .await
        .output
        .is_none()
    );
    assert!(h.forms.list(None).is_empty());
    assert!(h.fixture.authority.events.lock().unwrap().is_empty());
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn questions_use_real_forms_tool_ownership_and_first_options_for_yolo_and_goal() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let autonomy = autonomy::Service::new(h.fixture.authority.store.client());
    let input = r#"{"questions":[{"header":"Plan","question":"Which plan?","options":[{"label":"Fast (Recommended)","description":"Deploy together"},{"label":"Careful","description":"Roll out gradually"}]},{"header":"Env","question":"Which environment?","multiple":true,"options":[{"label":"Dev","description":"Development"}]}]}"#;
    for level in [2, 3] {
        autonomy
            .set_yolo(&h.context().session_id, YoloLevel::new(level).unwrap())
            .await
            .unwrap();
        let result = h.call("question", input).await;
        assert_eq!(
            get(output(&result), "answers"),
            &parse_json(r#"[["Fast (Recommended)"],[]]"#).unwrap()
        );
    }
    autonomy
        .set_yolo(&h.context().session_id, YoloLevel::OFF)
        .await
        .unwrap();
    autonomy
        .set_goal(
            &h.context().session_id,
            Goal::new("Choose safely", None, None),
        )
        .await
        .unwrap();
    assert!(h.call("question", input).await.output.is_some());
    let events = h.fixture.authority.events.lock().unwrap();
    let created = events
        .iter()
        .find(|event| event.type_ == "form.created")
        .unwrap();
    let form = get(&created.data, "form");
    assert_eq!(
        get(get(form, "metadata"), "tool"),
        &parse_json(r#"{"messageID":"msg_tool","callID":"call_tool"}"#).unwrap()
    );
    let JsonValue::Array(fields) = get(form, "fields") else {
        panic!()
    };
    assert!(get(&fields[0], "type") == &JsonValue::String("string".into()));
    assert_eq!(
        get(&fields[1], "type"),
        &JsonValue::String("multiselect".into())
    );
    drop(events);
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn human_question_waits_for_real_reply_and_cancellation_cleans_form() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    autonomy::Service::new(h.fixture.authority.store.client())
        .set_yolo(&h.context().session_id, YoloLevel::OFF)
        .await
        .unwrap();
    let created = Arc::new(Notify::new());
    let notify = created.clone();
    let original = h.fixture.authority.publisher();
    let forms = Forms::new(
        h.fixture.authority.authority(),
        Arc::new(move |event| {
            let wake = event.type_ == "form.created";
            let result = original(event);
            if wake {
                notify.notify_one();
            }
            result
        }),
    );
    let tool = Arc::new(ycoding_core::tools::builtin::question::Question {
        forms: forms.clone(),
        policy: h.fixture.policy.clone(),
    });
    let registered = h
        .registry
        .register(vec![("question".into(), tool)], Options::direct())
        .unwrap();
    let registry = h.registry.clone();
    let context = h.context();
    let task = tokio::spawn(async move {
        registry.materialize(&[]).invoke("question", parse_json(r#"{"questions":[{"header":"Review","question":"Paste exact evidence","options":[]},{"header":"Extra","question":"Anything else?","options":[]}]}"#).unwrap(), context).await
    });
    within(created.notified()).await;
    assert!(!task.is_finished());
    let form = forms.list(None).pop().unwrap();
    forms
        .reply(
            &form.id,
            form::Answer::decode(&parse_json(r#"{"q0":"Exact evidence"}"#).unwrap()).unwrap(),
        )
        .unwrap();
    let result = within(task).await.unwrap().unwrap();
    assert_eq!(
        get(output(&result), "answers"),
        &parse_json(r#"[["Exact evidence"],[]]"#).unwrap()
    );
    let registry = h.registry.clone();
    let context = h.context();
    let cancelled = context.cancellation.clone();
    let task = tokio::spawn(async move {
        registry
            .materialize(&[])
            .invoke(
                "question",
                parse_json(
                    r#"{"questions":[{"header":"Review","question":"Continue?","options":[]}]}"#,
                )
                .unwrap(),
                context,
            )
            .await
    });
    within(created.notified()).await;
    let form = forms.list(None).pop().unwrap();
    cancelled.cancel();
    assert!(within(task).await.unwrap().is_err());
    assert_eq!(forms.state(&form.id).unwrap(), form::State::Cancelled);
    drop(registered);
    h.close().await;
}

#[tokio::test]
async fn task_complete_declares_without_receipt_or_session_mutation_until_final_settlement() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let before = h.events();
    let result = h.call("task_complete", "{}").await;
    assert_eq!(
        output(&result),
        &parse_json(r#"{"recorded":true}"#).unwrap()
    );
    assert!(
        matches!(&result.result, llm::ToolResultValue::Text(text) if text == &JsonValue::String("Completion declaration recorded. Final reply settlement is still pending.".into()))
    );
    assert_eq!(h.events(), before);
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn subagent_launch_is_background_runs_real_runner_and_records_child_ceiling_and_terminal_notice()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let result = h.call("subagent", r#"{"agent":"explore","description":"Review","prompt":"Review this","background":false}"#).await;
    let id = child(&result);
    assert_eq!(
        get(output(&result), "status"),
        &JsonValue::String("running".into())
    );
    assert!(text(get(output(&result), "output")).contains("Do not poll"));
    let job = within(h.jobs.wait(id.as_lossless().as_str().unwrap(), None)).await;
    assert_eq!(job.info.unwrap().status, job::Status::Completed);
    let task = h.orchestration.get(&h.context().session_id, &id).unwrap();
    assert!(task.background);
    assert_eq!(
        task.state,
        ycoding_schema::session_orchestration::State::Completed
    );
    let child = h.store.get(&id).unwrap().unwrap();
    assert_eq!(child.parent_id, Some(h.context().session_id));
    assert_eq!(child.agent.as_ref().unwrap().as_str(), Some("explore"));
    assert_eq!(
        h.activations.lock().unwrap().as_slice(),
        &[LosslessString::from("explore")]
    );
    assert!(
        child
            .permission_ceiling
            .as_ref()
            .unwrap()
            .iter()
            .any(|rule| rule.action.as_str() == Some("question")
                && rule.effect.0.as_str() == Some("deny"))
    );
    assert!(h.store.context(&id).unwrap().iter().any(|message| matches!(message, session_message::Info::Assistant(assistant) if assistant.time.completed.is_some())));
    assert!(h.events().iter().any(
        |event| event.type_.as_str() == Some("session.task.updated.1")
            && ycoding_schema::stringify_json(&event.data).contains("completed")
    ));
    assert!(!h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn subagent_denial_invalid_variant_depth_and_ownership_reject_before_effect() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let initial = h.events();
    h.fixture.deny("subagent", "explore");
    assert!(
        h.call(
            "subagent",
            r#"{"agent":"explore","description":"Review","prompt":"Review"}"#
        )
        .await
        .output
        .is_none()
    );
    assert_eq!(h.events(), initial);
    assert!(
        h.orchestration
            .list(&h.context().session_id)
            .unwrap()
            .is_empty()
    );
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.fixture.authority.rules.lock().unwrap().pop();
    assert!(h.call("subagent", r#"{"agent":"explore","description":"Review","prompt":"Review","model":{"providerID":"openai","id":"gpt-reasoning","variant":"not-real"}}"#).await.output.is_none());
    assert!(
        h.orchestration
            .list(&h.context().session_id)
            .unwrap()
            .is_empty()
    );
    let result = h
        .call(
            "subagent",
            r#"{"agent":"explore","description":"Review","prompt":"Review"}"#,
        )
        .await;
    let id = child(&result);
    within(h.jobs.wait(id.as_lossless().as_str().unwrap(), None)).await;
    let before = h.events();
    let mut context = h.context();
    context.session_id = id.clone();
    context.agent = "explore".into();
    assert!(
        h.registry
            .materialize(&[])
            .invoke(
                "subagent",
                parse_json(r#"{"agent":"explore","description":"Nested","prompt":"Review"}"#)
                    .unwrap(),
                context
            )
            .await
            .unwrap()
            .output
            .is_none()
    );
    assert_eq!(h.events(), before);
    h.fixture
        .authority
        .session("ses_foreign", None, 1, false, None);
    let mut context = h.context();
    context.session_id = session::Id::new("ses_foreign").unwrap();
    assert!(
        h.registry
            .materialize(&[])
            .invoke(
                "subagent_control",
                parse_json(&format!(
                    r#"{{"action":"send","sessionID":"{}","text":"Steer","delivery":"steer"}}"#,
                    id.as_lossless().as_str().unwrap()
                ))
                .unwrap(),
                context
            )
            .await
            .unwrap()
            .output
            .is_none()
    );
    assert_eq!(h.events(), before);
    h.close().await;
}

#[tokio::test]
async fn bounded_child_timeout_interrupts_once_and_records_one_failed_task() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.hold();
    let result = h
        .call(
            "subagent",
            r#"{"agent":"explore","description":"Wait","prompt":"Review","timeout":40}"#,
        )
        .await;
    let id = child(&result);
    let finished = within(h.jobs.wait(id.as_lossless().as_str().unwrap(), None))
        .await
        .info
        .unwrap();
    assert_eq!(finished.status, job::Status::Error);
    assert!(finished.error.unwrap().contains("timed out"));
    assert_eq!(
        h.execution
            .interrupted
            .lock()
            .unwrap()
            .iter()
            .filter(|interrupted| **interrupted == id)
            .count(),
        1
    );
    assert_eq!(
        h.orchestration
            .get(&h.context().session_id, &id)
            .unwrap()
            .state,
        ycoding_schema::session_orchestration::State::Failed
    );
    h.close().await;
}

#[tokio::test]
async fn parent_send_reactivates_terminal_child_retries_idempotently_and_control_denial_is_zero_effect()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let id = child(
        &h.call(
            "subagent",
            r#"{"agent":"explore","description":"Review","prompt":"Review"}"#,
        )
        .await,
    );
    within(h.jobs.wait(id.as_lossless().as_str().unwrap(), None)).await;
    h.fixture.deny("subagent", "explore");
    let before = h.events();
    let send = format!(
        r#"{{"action":"send","sessionID":"{}","text":"Incremental context","delivery":"queue"}}"#,
        id.as_lossless().as_str().unwrap()
    );
    assert!(h.call("subagent_control", &send).await.output.is_none());
    assert_eq!(h.events(), before);
    h.fixture.authority.rules.lock().unwrap().pop();
    assert!(h.call("subagent_control", &send).await.output.is_some());
    within(h.execution.coordinator.run(&id)).await.unwrap();
    assert!(h.call("subagent_control", &send).await.output.is_some());
    assert!(h.store.pending_list(&id).unwrap().is_empty());
    assert!(
        h.call("subagent_control", r#"{"action":"list"}"#)
            .await
            .output
            .is_some()
    );
    h.close().await;
}

#[tokio::test]
async fn child_reports_are_durable_parent_owned_and_autonomous_questions_admit_literal_default() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    autonomy::Service::new(h.fixture.authority.store.client())
        .set_yolo(&h.context().session_id, YoloLevel::ANSWERS)
        .await
        .unwrap();
    h.server.hold();
    let id = child(
        &h.call(
            "subagent",
            r#"{"agent":"explore","description":"Wait","prompt":"Review"}"#,
        )
        .await,
    );
    h.server.entered().await;
    let mut context = h.context();
    context.session_id = id.clone();
    context.call_id = "call_progress".into();
    let result = h
        .registry
        .materialize(&[])
        .invoke(
            "subagent_report",
            parse_json(r#"{"action":"progress","text":"Verified progress"}"#).unwrap(),
            context.clone(),
        )
        .await
        .unwrap();
    assert!(result.output.is_some());
    let result = h
        .registry
        .materialize(&[])
        .invoke(
            "subagent_report",
            parse_json(r#"{"action":"question","text":"Which approach?"}"#).unwrap(),
            context.clone(),
        )
        .await
        .unwrap();
    assert!(result.output.is_some());
    assert!(h.store.pending_list(&id).unwrap().iter().any(|pending| {
        ycoding_schema::stringify_json(&pending.data)
            .contains("Continue with the safest reasonable default.")
    }));
    autonomy::Service::new(h.fixture.authority.store.client())
        .set_yolo(&h.context().session_id, YoloLevel::OFF)
        .await
        .unwrap();
    let result = h
        .registry
        .materialize(&[])
        .invoke(
            "subagent_report",
            parse_json(r#"{"action":"question","text":"Need human decision"}"#).unwrap(),
            context,
        )
        .await
        .unwrap();
    assert!(result.output.is_some());
    assert_eq!(
        h.orchestration
            .get(&h.context().session_id, &id)
            .unwrap()
            .state,
        ycoding_schema::session_orchestration::State::Waiting
    );
    within(h.jobs.wait(id.as_lossless().as_str().unwrap(), None)).await;
    assert_eq!(
        h.jobs
            .get(id.as_lossless().as_str().unwrap())
            .unwrap()
            .status,
        job::Status::Cancelled
    );
    let question = h
        .orchestration
        .get(&h.context().session_id, &id)
        .unwrap()
        .question
        .unwrap();
    let answer = format!(
        r#"{{"action":"answer","sessionID":"{}","questionID":"{}","text":"Use the verified option","data":{{"route":"accepted"}}}}"#,
        id.as_lossless().as_str().unwrap(),
        question.id.0.as_str().unwrap()
    );
    *h.server.gate.lock().unwrap() = None;
    assert!(h.call("subagent_control", &answer).await.output.is_some());
    within(h.execution.coordinator.run(&id)).await.unwrap();
    assert!(h.store.context(&id).unwrap().iter().any(|message| matches!(message, session_message::Info::Synthetic(message) if message.text.to_utf8().unwrap().contains("Use the verified option"))));
    let resume = format!(
        r#"{{"action":"resume","sessionID":"{}"}}"#,
        id.as_lossless().as_str().unwrap()
    );
    assert!(h.call("subagent_control", &resume).await.output.is_none());
    let cancel = format!(
        r#"{{"action":"cancel","sessionID":"{}"}}"#,
        id.as_lossless().as_str().unwrap()
    );
    assert!(h.call("subagent_control", &cancel).await.output.is_some());
    assert_eq!(
        h.orchestration
            .get(&h.context().session_id, &id)
            .unwrap()
            .state,
        ycoding_schema::session_orchestration::State::Cancelled
    );
    assert!(
        h.call(
            "subagent_report",
            r#"{"action":"progress","text":"No parent"}"#
        )
        .await
        .output
        .is_none()
    );
    h.close().await;
}

#[tokio::test]
async fn decision_registry_denial_has_no_provider_ledger_usage_or_durable_effect() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Text(answer().into()));
    h.fixture.deny("decision", "agent");
    let before = h.events();
    assert!(h.call("decision", request()).await.output.is_none());
    assert!(h.server.seen.lock().unwrap().is_empty());
    assert!(h.ledger().is_empty());
    assert_eq!(h.events(), before);
    h.close().await;
}

#[tokio::test]
async fn decision_real_model_returns_typed_confidence_no_tools_and_accounts_usage_and_cache_reporting()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Text(answer().into()));
    let result = h.call("decision", request()).await;
    let response = get(output(&result), "response");
    assert_eq!(
        get(response, "semantics"),
        &JsonValue::String("model-estimate".into())
    );
    assert_eq!(get(response, "answers"), &parse_json(r#"[{"name":"route","type":"choice","answer":null,"choice":"review","score":null,"confidence":0.8}]"#).unwrap());
    let ledger = h.ledger();
    assert_eq!(ledger.len(), 1);
    assert_eq!(ledger[0].source.as_str(), Some("decision"));
    assert_eq!(ledger[0].cache_read_reported, Some(1));
    assert!(ledger[0].cost.is_some());
    assert_eq!(
        ledger[0].tokens.value(),
        &parse_json(r#"{"input":8,"output":5,"reasoning":2,"cache":{"read":4,"write":0}}"#)
            .unwrap()
    );
    let seen = h.server.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    let serialized = ycoding_schema::stringify_json(&seen[0]);
    assert!(serialized.contains("uncalibrated"));
    assert!(serialized.contains("alternatives"));
    assert!(!serialized.contains("\"tools\":[{"));
    drop(seen);
    assert!(
        h.events()
            .iter()
            .any(|event| event.type_.as_str() == Some("session.usage.recorded.1"))
    );
    h.close().await;
}

#[tokio::test]
async fn decision_refusal_remains_uncertainty_and_missing_usage_is_not_reported_as_zero() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::NoUsage(
        answer().replace("choice,null,review,null,0.8", "refusal,null,null,null,0"),
    ));
    let result = h.call("decision", request()).await;
    let response = get(output(&result), "response");
    let JsonValue::Object(response) = response else {
        panic!()
    };
    assert!(response.get(&"usage".into()).is_none());
    assert!(result.output.as_ref().unwrap().content.iter().any(|content| matches!(content, ycoding_schema::llm::ToolContent::Text(text) if text.text.to_utf8().unwrap().contains("Treat refusal as uncertainty"))));
    assert_eq!(h.ledger()[0].cost, None);
    assert_eq!(h.ledger()[0].cache_read_reported, Some(0));
    h.close().await;
}

#[tokio::test]
async fn decision_invalid_output_provider_failure_unsettled_and_tool_injection_fail_closed_once() {
    for reply in [
        Reply::Text(r#"{"probability":1}"#.into()),
        Reply::Rejected,
        Reply::Unsettled(answer().into()),
        Reply::Tool("shell".into()),
    ] {
        let h = Harness::new(TitleMode::Local, "{}").await;
        h.server.set(reply);
        assert!(h.call("decision", request()).await.output.is_none());
        assert_eq!(h.server.seen.lock().unwrap().len(), 1);
        assert_eq!(h.ledger().len(), 1);
        h.close().await;
    }
}

#[tokio::test]
async fn decision_cancellation_is_explicit_closes_wait_and_still_records_attempt_without_retry() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Text(answer().into()));
    h.server.hold();
    let context = h.context();
    let cancellation = context.cancellation.clone();
    let registry = h.registry.clone();
    let task = tokio::spawn(async move {
        registry
            .materialize(&[])
            .invoke("decision", parse_json(request()).unwrap(), context)
            .await
    });
    h.server.entered().await;
    assert!(!task.is_finished());
    cancellation.cancel();
    assert!(within(task).await.unwrap().is_err());
    assert_eq!(h.ledger().len(), 1);
    assert_eq!(h.server.seen.lock().unwrap().len(), 1);
    h.close().await;
}

#[tokio::test]
async fn decision_invalid_request_errors_are_corrective_and_never_echo_evidence() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    for (question, path) in [
        (
            r#"{"type":"classify","name":"route","instructions":"Classify"}"#,
            "questions[0].type",
        ),
        (
            r#"{"type":"choice","name":"route","instructions":"Choose","choices":[{"value":42,"description":"do-not-echo-secret"}]}"#,
            "request.questions[0].choices[0].value",
        ),
        (
            r#"{"type":"score","name":"route","instructions":"Grade","levels":[{"label":"do-not-echo-secret"}]}"#,
            "request.questions[0].levels",
        ),
    ] {
        let result = h.call("decision", &format!(r#"{{"provider":"agent","request":{{"state":{{"secret":"do-not-echo-secret"}},"questions":[{question}]}}}}"#)).await;
        assert!(result.output.is_none());
        let value = format!("{:?}", result.result);
        assert!(value.contains(path));
        assert!(value.contains("Minimal valid"));
        assert!(!value.contains("do-not-echo-secret"));
    }
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[test]
fn judgment_request_bounds_typed_choices_and_strict_toon_answers_match_ts() {
    let request = Request::decode(&parse_json(r#"{"state":{"task":"Unicode 日本語"},"questions":[{"type":"predicate","name":"safe","instructions":"Safe?"},{"type":"choice","name":"方式","instructions":"Choose","choices":[{"value":false},{"value":"false"},{"value":"0"}]},{"type":"score","name":"effort","instructions":"Grade","levels":[{"label":"low"},{"label":"high"}]},{"type":"predicate","name":"unknown","instructions":"Unknown?"}]}"#).unwrap()).unwrap();
    let wire = "decisions:\n  version: 1\n  answers[4]{name,type,answer,choice,score,confidence}:\n    safe,predicate,false,null,null,0.9\n    方式,choice,null,false,null,1\n    effort,score,null,null,0,0\n    unknown,refusal,null,null,null,0";
    assert_eq!(request.parse(wire).unwrap().len(), 4);
    assert!(request.parse(&request.template()).is_ok());
    let reversed = wire
        .lines()
        .take(3)
        .chain(wire.lines().skip(3).collect::<Vec<_>>().into_iter().rev())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        request.parse(&reversed).unwrap(),
        request.parse(wire).unwrap()
    );
    for invalid in [
        wire.replace("safe,predicate,false", "safe,predicate,null"),
        wire.replace("effort,score,null,null,0", "effort,score,null,null,2"),
        wire.replace("effort,score,null,null,0", "effort,score,null,null,0.5"),
        wire.replace("方式,choice,null,false", "方式,choice,null,true"),
        wire.replace(
            "unknown,refusal,null,null,null,0",
            "unknown,refusal,null,null,null,0.1",
        ),
        wire.replace(
            "safe,predicate,false,null,null,0.9",
            "safe,predicate,false,other,null,0.9",
        ),
        wire.replace("unknown,refusal", "safe,refusal"),
        wire.replace("version: 1", "version: 2"),
        format!("```toon\n{wire}\n```"),
        format!("Here is my decision:\n{wire}"),
        format!("{wire}\nTrailing prose"),
        format!("{wire}\n{wire}"),
        wire.lines().take(6).collect::<Vec<_>>().join("\n"),
    ] {
        assert_eq!(request.parse(&invalid), Err(decision::Error::InvalidOutput));
    }
    for choice in ["false", "0"] {
        assert!(
            request
                .parse(&wire.replace(
                    "方式,choice,null,false",
                    &format!("方式,choice,null,\"{choice}\"")
                ))
                .is_ok()
        );
    }
    for delimiter in [',', '|', '\t'] {
        let alternate = wire
            .replace("answers[4]", &format!("answers[4{delimiter}]"))
            .replace(',', &delimiter.to_string());
        assert_eq!(
            request.parse(&alternate).unwrap(),
            request.parse(wire).unwrap()
        );
    }
    let oversized = "é".repeat(524289);
    assert_eq!(
        request.parse(&oversized),
        Err(decision::Error::InvalidOutput)
    );
    for invalid in [
        r#"{"state":{},"questions":[]}"#,
        r#"{"state":{},"questions":[{"type":"predicate","name":"same","instructions":"One"},{"type":"predicate","name":"same","instructions":"Two"}]}"#,
        r#"{"state":{},"questions":[{"type":"choice","name":"route","instructions":"Choose","choices":[{"value":false},{"value":false}]}]}"#,
        r#"{"state":{},"questions":[{"type":"score","name":"effort","instructions":"Grade","levels":[{"label":"one"}]}]}"#,
    ] {
        assert_eq!(
            Request::decode(&parse_json(invalid).unwrap()).unwrap_err(),
            decision::Error::InvalidRequest
        );
    }
}

#[tokio::test]
async fn title_local_off_sole_user_child_exclusion_and_idempotence_have_no_provider_calls() {
    for mode in [TitleMode::Local, TitleMode::Off] {
        let h = Harness::new(mode, "{}").await;
        h.prompt(
            "# Help debug the failing build\nIgnore second line",
            "first",
        )
        .await;
        let service = h.title();
        let id = h.context().session_id;
        let info = h.store.get(&id).unwrap().unwrap();
        let before = h.events();
        service
            .generate_for_first_prompt(&info, &Cancellation::default())
            .await
            .unwrap();
        service
            .generate_for_first_prompt(&info, &Cancellation::default())
            .await
            .unwrap();
        assert_eq!(
            h.store.get(&id).unwrap().unwrap().title.as_str(),
            Some(if mode == TitleMode::Off {
                "authority"
            } else {
                "Help debug the failing build"
            })
        );
        assert!(h.server.seen.lock().unwrap().is_empty());
        assert_eq!(
            h.events().len() - before.len(),
            usize::from(mode == TitleMode::Local)
        );
        h.close().await;
    }
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.prompt("First", "first").await;
    h.prompt("Second", "second").await;
    h.title()
        .generate_for_first_prompt(
            &h.store.get(&h.context().session_id).unwrap().unwrap(),
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        h.store
            .get(&h.context().session_id)
            .unwrap()
            .unwrap()
            .title
            .as_str(),
        Some("authority")
    );
    h.close().await;
}

#[tokio::test]
async fn title_model_uses_helper_accounting_and_failure_renames_to_local_title() {
    for reply in [
        Reply::Text("  Generated Title\nIgnored line".into()),
        Reply::Rejected,
        Reply::Text("  \n ".into()),
    ] {
        let h = Harness::new(TitleMode::Model, "{}").await;
        let generated = matches!(&reply, Reply::Text(text) if text.contains("Generated"));
        h.server.set(reply);
        h.prompt("Fix failing build", "first").await;
        let info = h.store.get(&h.context().session_id).unwrap().unwrap();
        h.title()
            .generate_for_first_prompt(&info, &Cancellation::default())
            .await
            .unwrap();
        assert_eq!(
            h.store.get(&info.id).unwrap().unwrap().title.as_str(),
            Some(if generated {
                "Generated Title"
            } else {
                "Fix failing build"
            })
        );
        assert_eq!(h.server.seen.lock().unwrap().len(), 1);
        assert_eq!(h.ledger().len(), 1);
        assert_eq!(h.ledger()[0].source.as_str(), Some("title"));
        assert_eq!(
            h.ledger()[0].input_id.as_ref().unwrap().as_str(),
            Some("msg_first")
        );
        h.close().await;
    }
}

#[tokio::test]
async fn title_missing_telemetry_records_zero_usage_but_no_reported_cost_or_cache_hit() {
    let h = Harness::new(TitleMode::Model, "{}").await;
    h.server.set(Reply::NoUsage("Generated Title".into()));
    h.prompt("First prompt", "first").await;
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    h.title()
        .generate_for_first_prompt(&info, &Cancellation::default())
        .await
        .unwrap();
    let usage = h
        .events()
        .into_iter()
        .filter(|event| event.type_.as_str() == Some("session.usage.recorded.1"))
        .collect::<Vec<_>>();
    assert_eq!(usage.len(), 1);
    assert_eq!(get(&usage[0].data, "cost"), &JsonValue::Number(0.0));
    assert_eq!(
        get(&usage[0].data, "tokens"),
        &ycoding_core::session::usage::tokens(None)
    );
    assert_eq!(h.ledger()[0].cost, None);
    assert_eq!(h.ledger()[0].cache_read_reported, None);
    assert_eq!(
        h.store.get(&info.id).unwrap().unwrap().title.as_str(),
        Some("Generated Title")
    );
    assert_eq!(h.store.get(&info.id).unwrap().unwrap().tokens, info.tokens);
    h.close().await;
}

fn image() -> image_analyzer::Input {
    image_analyzer::Input {
        file: image_analyzer::Image {
            mime: "image/png".into(),
            name: Some("photo.png".into()),
            description: Some("Source image".into()),
            digest: "abc123def456".repeat(6),
            bytes: 3,
        },
        bytes: vec![1, 2, 3],
    }
}
#[test]
fn image_fallback_block_preserves_toon_verbatim_and_failure_preserves_metadata() {
    let file = image().file;
    let toon = "scene:\n  overview: A cat\nobjects[1]{type,count}:\n  cat,1";
    let block = image_analyzer::format_fallback_block(
        &file,
        &format!("```toon\n{toon}\n```"),
        Some("vision/model"),
    );
    assert!(block.contains(toon));
    assert!(block.starts_with("[Image Analysis: photo.png (image/png) via vision/model]"));
    assert!(block.contains("Original description: Source image"));
    let failure = image_analyzer::failure_block(&file, "unavailable");
    assert!(failure.contains("— FAILED]"));
    assert!(failure.contains(&format!("SHA-256: {}", file.digest)));
    assert!(failure.contains("Bytes: 3"));
}

#[tokio::test]
async fn image_analyzer_real_vision_requests_memoize_success_only_and_enforce_limits() {
    let h = Harness::new(
        TitleMode::Local,
        r#"{"image_analyzer":{"model":"openai/gpt-reasoning","max_images":1,"max_bytes":4}}"#,
    )
    .await;
    h.server.set(Reply::Text(
        "```toon\nscene:\n  overview: A cat\nobjects[1]{type,count}:\n  cat,1\n```".into(),
    ));
    let service = h.image();
    let input = image();
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    let first = service
        .analyze(
            &[input.clone()],
            Some(&info),
            None,
            &Cancellation::default(),
        )
        .await
        .unwrap();
    let second = service
        .analyze(
            &[input.clone()],
            Some(&info),
            None,
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(first, second);
    assert_eq!(h.server.seen.lock().unwrap().len(), 1);
    let mut overflow = input.clone();
    overflow.file.digest = "overflow".into();
    let results = service
        .analyze(
            &[input.clone(), overflow],
            Some(&info),
            None,
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert!(results["overflow"].contains("exceeds max_images 1"));
    let mut large = input.clone();
    large.file.digest = "large".into();
    large.bytes = vec![0; 5];
    assert!(
        service
            .analyze(&[large], Some(&info), None, &Cancellation::default())
            .await
            .unwrap()["large"]
            .contains("image exceeds max_bytes 4")
    );
    h.server.set(Reply::Rejected);
    let mut failed = input;
    failed.file.digest = "failed".into();
    for _ in 0..2 {
        let result = service
            .analyze(
                &[failed.clone()],
                Some(&info),
                None,
                &Cancellation::default(),
            )
            .await
            .unwrap();
        assert!(result["failed"].contains("[analysis failed]"));
    }
    assert_eq!(h.server.seen.lock().unwrap().len(), 3);
    assert!(h.ledger().is_empty());
    h.close().await;
}

#[tokio::test]
async fn unconfigured_text_only_image_fallback_is_explicit_and_multimodal_models_keep_media() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let input = image();
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    let result = h
        .image()
        .fallback_for_text_model(&[input.clone()], &info, None, &Cancellation::default())
        .await
        .unwrap()
        .unwrap();
    assert!(result[&input.file.digest].contains("image analyzer not configured"));
    let capabilities = ycoding_schema::model::Capabilities {
        tools: true,
        input: vec!["image/png".into()],
        output: vec!["text".into()],
    };
    assert!(
        h.image()
            .fallback_for_text_model(
                &[input],
                &info,
                Some(&capabilities),
                &Cancellation::default()
            )
            .await
            .unwrap()
            .is_none()
    );
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn transient_generate_uses_fresh_durable_context_and_never_mutates_session_or_ledger() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.prompt("Existing durable context", "first").await;
    let before = h.events();
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    let result = h
        .generator()
        .generate(
            &h.context().session_id,
            "Summarize privately".into(),
            &Cancellation::default(),
        )
        .await
        .unwrap();
    assert_eq!(result.as_str(), Some("Verified response"));
    assert_eq!(h.events(), before);
    assert_eq!(h.store.get(&info.id).unwrap().unwrap(), info);
    assert!(h.ledger().is_empty());
    let seen = h.server.seen.lock().unwrap();
    let request = ycoding_schema::stringify_json(&seen[0]);
    assert!(request.contains("Existing durable context"));
    assert!(request.contains("Summarize privately"));
    assert!(request.contains("Initial context"));
    assert!(!request.contains("\"tools\":[{"));
    drop(seen);
    h.close().await;
}

#[tokio::test]
async fn transient_generation_blocks_initial_unavailable_instructions_without_provider_or_durable_effect()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let before = h.events();
    let mut generate = h.generator();
    generate.instructions = vec![ycoding_core::instructions::Source {
        key: ycoding_schema::instruction::Key::decode(&JsonValue::String("test/context".into()))
            .unwrap(),
        read: Arc::new(|| {
            Box::pin(async { Ok(ycoding_core::instructions::Observation::Unavailable) })
        }),
        initial: Arc::new(|_| Some("Initial".into())),
        changed: Arc::new(|_, _| Some("Changed".into())),
        removed: None,
    }];
    assert!(matches!(
        generate
            .generate(
                &h.context().session_id,
                "Private".into(),
                &Cancellation::default()
            )
            .await,
        Err(generate::Error::Instructions(
            ycoding_core::instructions::Error::InitializationBlocked(_)
        ))
    ));
    assert!(h.server.seen.lock().unwrap().is_empty());
    assert_eq!(h.events(), before);
    h.close().await;
}

#[tokio::test]
async fn pre_cancelled_session_tools_perform_no_service_effects() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let before = h.events();
    for (name, input) in [
        ("task_complete", "{}"),
        ("todowrite", r#"{"todos":[]}"#),
        ("goal", r#"{"action":"get"}"#),
        (
            "question",
            r#"{"questions":[{"question":"Continue?","header":"Review","options":[]}]}"#,
        ),
        (
            "subagent",
            r#"{"agent":"explore","description":"Review","prompt":"Review"}"#,
        ),
        ("subagent_control", r#"{"action":"list"}"#),
        (
            "subagent_report",
            r#"{"action":"progress","text":"Review"}"#,
        ),
        ("decision", request()),
    ] {
        let context = h.context();
        context.cancellation.cancel();
        let result = h
            .registry
            .materialize(&[])
            .invoke(name, parse_json(input).unwrap(), context)
            .await;
        assert!(result.is_err(), "{name}");
    }
    assert_eq!(h.events(), before);
    assert!(h.ledger().is_empty());
    assert!(h.forms.list(None).is_empty());
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn usage_recorded_projects_helper_totals_and_step_totals_exactly_once_without_message_or_timestamp_change()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let id = h.context().session_id;
    let before = h.store.get(&id).unwrap().unwrap();
    let messages = h.store.context(&id).unwrap();
    helper::publish(&h.store, &id, "session.usage.recorded.1", parse_json(r#"{"sessionID":"ses_tool","source":"decision","cost":0.125,"tokens":{"input":8,"output":5,"reasoning":2,"cache":{"read":4,"write":1}}}"#).unwrap(), 50).await.unwrap();
    let helper_total = h.store.get(&id).unwrap().unwrap();
    assert_eq!(helper_total.cost.get(), before.cost.get() + 0.125);
    assert_eq!(
        helper_total.tokens.input.get(),
        before.tokens.input.get() + 8.0
    );
    assert_eq!(helper_total.tokens.output.get(), 5.0);
    assert_eq!(helper_total.tokens.reasoning.get(), 2.0);
    assert_eq!(helper_total.tokens.cache.read.get(), 4.0);
    assert_eq!(helper_total.tokens.cache.write.get(), 1.0);
    assert_eq!(helper_total.time.updated, before.time.updated);
    assert_eq!(h.store.context(&id).unwrap(), messages);
    h.prompt("Run the step", "first").await;
    h.server.set(Reply::Text("Step settled".into()));
    within(h.execution.coordinator.run(&id)).await.unwrap();
    let combined = h.store.get(&id).unwrap().unwrap();
    assert_eq!(combined.tokens.input.get(), 16.0);
    assert_eq!(combined.tokens.output.get(), 10.0);
    assert_eq!(combined.tokens.reasoning.get(), 4.0);
    assert_eq!(combined.tokens.cache.read.get(), 8.0);
    assert_eq!(combined.tokens.cache.write.get(), 1.0);
    assert!(combined.cost.get() > helper_total.cost.get());
    let snapshot = h.fixture.authority.store.snapshot().unwrap();
    let row = snapshot
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(id.as_lossless())]))
        .unwrap()
        .unwrap();
    assert_eq!(row.tokens_input, 16);
    drop(snapshot);
    h.close().await;
}

#[tokio::test]
async fn title_child_exclusion_unavailable_helper_and_model_length_bound_match_ts() {
    let h = Harness::new(TitleMode::Model, "{}").await;
    h.prompt("A local title", "first").await;
    let mut info = h.store.get(&h.context().session_id).unwrap().unwrap();
    info.parent_id = Some(session::Id::new("ses_parent").unwrap());
    h.title()
        .generate_for_first_prompt(&info, &Cancellation::default())
        .await
        .unwrap();
    assert!(h.server.seen.lock().unwrap().is_empty());
    assert_eq!(
        h.store.get(&info.id).unwrap().unwrap().title.as_str(),
        Some("authority")
    );
    info.parent_id = None;
    let missing = title::Service::new(
        h.store.clone(),
        Arc::new(agent::Service::new(vec![])),
        h.models.clone(),
        h.executor.clone(),
    );
    missing
        .generate_for_first_prompt(&info, &Cancellation::default())
        .await
        .unwrap();
    assert_eq!(
        h.store.get(&info.id).unwrap().unwrap().title.as_str(),
        Some("A local title")
    );
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.server.set(Reply::Text("x".repeat(120)));
    h.title()
        .generate_for_first_prompt(&info, &Cancellation::default())
        .await
        .unwrap();
    let title = h.store.get(&info.id).unwrap().unwrap().title;
    assert_eq!(title.code_units().count(), 100);
    assert_eq!(title.to_utf8().unwrap(), format!("{}...", "x".repeat(97)));
    h.close().await;
}

#[test]
fn judgment_accepts_exact_question_and_choice_bounds_and_rejects_excess() {
    let choices = std::iter::once(
        ObjectEncoder::new()
            .field("value", &false)
            .field("description", "d".repeat(8192).as_str())
            .finish(),
    )
    .chain((0..254).map(|index| {
        ObjectEncoder::new()
            .field("value", format!("route-{index}").as_str())
            .finish()
    }))
    .collect::<Vec<_>>();
    let questions = std::iter::once(
        ObjectEncoder::new()
            .field("type", "choice")
            .field("name", "n".repeat(64).as_str())
            .field("instructions", "i".repeat(8192).as_str())
            .field("choices", &choices)
            .finish(),
    )
    .chain((0..31).map(|index| {
        ObjectEncoder::new()
            .field("type", "predicate")
            .field("name", format!("q{index}").as_str())
            .field("instructions", "Judge")
            .finish()
    }))
    .collect::<Vec<_>>();
    let input = ObjectEncoder::new()
        .field("state", &JsonValue::Null)
        .field("questions", &questions)
        .finish();
    let request = Request::decode(&input).unwrap();
    assert_eq!(request.parse(&request.template()).unwrap().len(), 32);
    let mut too_many = questions.clone();
    too_many.push(
        ObjectEncoder::new()
            .field("type", "predicate")
            .field("name", "excess")
            .field("instructions", "Judge")
            .finish(),
    );
    assert!(
        Request::decode(
            &ObjectEncoder::new()
                .field("state", &JsonValue::Null)
                .field("questions", &too_many)
                .finish()
        )
        .is_err()
    );
    let mut excess = choices;
    excess.push(ObjectEncoder::new().field("value", "excess").finish());
    assert!(
        Request::decode(
            &ObjectEncoder::new()
                .field("state", &JsonValue::Null)
                .field(
                    "questions",
                    &vec![
                        ObjectEncoder::new()
                            .field("type", "choice")
                            .field("name", "route")
                            .field("instructions", "Judge")
                            .field("choices", &excess)
                            .finish()
                    ]
                )
                .finish()
        )
        .is_err()
    );
}

#[tokio::test]
async fn decision_backend_score_and_boolean_predicate_support_explicit_refusal_and_zero_confidence()
{
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Text("decisions:\n  version: 1\n  answers[3]{name,type,answer,choice,score,confidence}:\n    safe,predicate,false,null,null,0\n    effort,score,null,null,0,0.84\n    unknown,refusal,null,null,null,0".into()));
    let result = h.call("decision", r#"{"provider":"agent","request":{"state":{},"questions":[{"type":"predicate","name":"safe","instructions":"Safe?"},{"type":"score","name":"effort","instructions":"Grade","levels":[{"label":"low"},{"label":"high"}]},{"type":"choice","name":"unknown","instructions":"Choose","choices":[{"value":false}]}]}}"#).await;
    let JsonValue::Array(answers) = get(get(output(&result), "response"), "answers") else {
        panic!()
    };
    assert_eq!(get(&answers[0], "answer"), &JsonValue::Bool(false));
    assert_eq!(get(&answers[0], "confidence"), &JsonValue::Number(0.0));
    assert_eq!(get(&answers[1], "score"), &JsonValue::Number(0.0));
    assert_eq!(
        get(&answers[2], "type"),
        &JsonValue::String("refusal".into())
    );
    h.close().await;
}

#[tokio::test]
async fn decision_input_byte_limit_prevents_request_and_output_byte_limit_still_accounts_attempt() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let JsonValue::Object(mut input) = parse_json(request()).unwrap() else {
        panic!()
    };
    let JsonValue::Object(mut request_value) = input.get(&"request".into()).unwrap().clone() else {
        panic!()
    };
    request_value.insert("state".into(), JsonValue::String("é".repeat(524289).into()));
    input.insert("request".into(), JsonValue::Object(request_value));
    let result = h
        .registry
        .materialize(&[])
        .invoke("decision", JsonValue::Object(input), h.context())
        .await
        .unwrap();
    assert!(result.output.is_none());
    assert!(format!("{:?}", result.result).contains("1 MiB"));
    assert!(h.server.seen.lock().unwrap().is_empty());
    assert!(h.ledger().is_empty());
    h.server.set(Reply::Text("é".repeat(524289)));
    assert!(h.call("decision", request()).await.output.is_none());
    assert_eq!(h.server.seen.lock().unwrap().len(), 1);
    assert_eq!(h.ledger().len(), 1);
    h.close().await;
}

#[tokio::test]
async fn transient_generation_cancels_provider_without_recording_or_promoting_input() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.prompt("Durable context", "first").await;
    let before = h.events();
    h.server.hold();
    let generate = h.generator();
    let id = h.context().session_id;
    let cancellation = Cancellation::default();
    let token = cancellation.clone();
    let task = tokio::spawn(async move { generate.generate(&id, "Private".into(), &token).await });
    h.server.entered().await;
    cancellation.cancel();
    assert!(matches!(
        within(task).await.unwrap(),
        Err(generate::Error::Cancelled)
    ));
    assert_eq!(h.events(), before);
    assert!(h.ledger().is_empty());
    h.close().await;
}

#[tokio::test]
async fn compaction_advisor_rearms_normal_pressure_skips_helpers_and_retries_failed_rising_edges() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let advisor = Advisor::new(
        h.store.clone(),
        ycoding_core::session::compaction_policy::Resolved {
            context_safety_margin_tokens: 0,
            advisory: ycoding_core::session::compaction_policy::Advisory::Thresholds {
                consider_percent: 65,
                strongly_advised_percent: 85,
            },
            ..Default::default()
        },
    );
    let resolved = h
        .models
        .resolve(
            &h.store.get(&h.context().session_id).unwrap().unwrap(),
            &ycoding_schema::model::Ref::decode(
                &parse_json(r#"{"providerID":"openai","id":"gpt-reasoning"}"#).unwrap(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let mut request = llm::Request::new(resolved.model);
    request.system = vec!["x".repeat(240).as_str().into()];
    let calls = Arc::new(Mutex::new(Vec::new()));
    for (window, agent, expected) in [
        (90, "compaction", 0),
        (100, "test", 0),
        (90, "test", 1),
        (90, "test", 2),
        (70, "test", 3),
        (60, "test", 3),
        (90, "test", 3),
        (100, "test", 3),
        (90, "test", 4),
    ] {
        let calls = calls.clone();
        let result = advisor
            .observe(
                conversation_compact::Context {
                    session: &h.context().session_id,
                    agent: &agent.into(),
                    capabilities: Some(ycoding_core::session::context_pressure::Capabilities {
                        context_window_tokens: window,
                        max_output_tokens: 0,
                        context_safety_margin_tokens: 0,
                    }),
                    request: &request,
                },
                |trigger, estimate| {
                    assert!(estimate > 0);
                    calls.lock().unwrap().push(trigger);
                    Err(
                        ycoding_core::session::compaction_job::CompactionError::Conflict {
                            id: None,
                            message: "No completed compaction boundary is available".into(),
                        },
                    )
                },
            )
            .await;
        assert_eq!(calls.lock().unwrap().len(), expected);
        if expected == 0 || window == 60 || window == 100 || (window == 90 && expected == 3) {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err());
        }
    }
    assert!(h.events().is_empty());
    h.close().await;
}

#[tokio::test]
async fn compaction_advisor_rising_edge_admits_one_real_durable_job_without_a_model_tool() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.prompt("First boundary", "first").await;
    within(h.execution.coordinator.run(&h.context().session_id))
        .await
        .unwrap();
    h.fixture
        .authority
        .store
        .submit(|tx| {
            ycoding_store::session::RevisionTable::put(
                tx,
                &ycoding_store::session::Revision {
                    session_id: "ses_tool".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ycoding_store::session::ContextStateTable::put(
                tx,
                &ycoding_store::session::ContextState {
                    session_id: "ses_tool".into(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    let policy = ycoding_core::session::compaction_policy::Resolved {
        context_safety_margin_tokens: 0,
        advisory: ycoding_core::session::compaction_policy::Advisory::Thresholds {
            consider_percent: 65,
            strongly_advised_percent: 85,
        },
        ..Default::default()
    };
    let advisor = Advisor::new(h.store.clone(), policy);
    let resolved = h
        .models
        .resolve(
            &h.store.get(&h.context().session_id).unwrap().unwrap(),
            &ycoding_schema::model::Ref::decode(
                &parse_json(r#"{"providerID":"openai","id":"gpt-reasoning"}"#).unwrap(),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let mut request = llm::Request::new(resolved.model);
    request.system = vec!["x".repeat(240).as_str().into()];
    let boundary = h
        .store
        .model_history(&h.context().session_id)
        .unwrap()
        .pop()
        .unwrap();
    let session_message::Info::Assistant(assistant) = boundary.message else {
        panic!()
    };
    let result = advisor
        .observe(
            conversation_compact::Context {
                session: &h.context().session_id,
                agent: &"test".into(),
                capabilities: Some(ycoding_core::session::context_pressure::Capabilities {
                    context_window_tokens: 90,
                    max_output_tokens: 0,
                    context_safety_margin_tokens: 0,
                }),
                request: &request,
            },
            |trigger, estimate| {
                Ok(ycoding_core::session::compaction_job::AdmitInput {
                    id: None,
                    session: h.context().session_id,
                    trigger,
                    requested_through_message: assistant.id,
                    requested_through_seq: boundary.seq,
                    base_context_revision: 0,
                    target_max_input_tokens: 50,
                    config_digest: ycoding_core::session::compaction_policy::admission_digest(
                        &policy,
                    ),
                    pressure: Some(session_compaction::Pressure {
                        estimated_input_tokens: ycoding_schema::schema::NonNegativeInt::new(
                            estimate,
                        )
                        .unwrap(),
                        safe_input_tokens: ycoding_schema::schema::NonNegativeInt::new(90).unwrap(),
                    }),
                })
            },
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status.as_str(), Some("pending"));
    assert_eq!(
        h.store
            .compaction_pending(&h.context().session_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(
        advisor
            .observe(
                conversation_compact::Context {
                    session: &h.context().session_id,
                    agent: &"test".into(),
                    capabilities: Some(ycoding_core::session::context_pressure::Capabilities {
                        context_window_tokens: 90,
                        max_output_tokens: 0,
                        context_safety_margin_tokens: 0
                    }),
                    request: &request
                },
                |_, _| panic!("same pressure must not readmit")
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        h.events()
            .iter()
            .filter(|event| event.type_.as_str() == Some("session.compaction.admitted.2"))
            .count(),
        1
    );
    h.close().await;
}

#[tokio::test]
async fn transient_generation_with_a_tampered_attachment_degrades_to_metadata_without_durable_mutation()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let content = h.attachments.import(&[1, 2, 3]).unwrap();
    let file = ObjectEncoder::new()
        .field("content", &content)
        .field("mime", "image/png")
        .field("name", "photo.png")
        .finish();
    h.store
        .admit_input(pending::Request {
            id: session_message::Id::new("msg_attachment").unwrap(),
            session_id: h.context().session_id,
            input: session_pending::Message::decode(
                &ObjectEncoder::new()
                    .field("type", "user")
                    .field(
                        "data",
                        &ObjectEncoder::new()
                            .field("text", "Inspect the attachment")
                            .field("files", &vec![file])
                            .finish(),
                    )
                    .field("delivery", "steer")
                    .finish(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_attachment").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
    h.store
        .promote_steers(&h.context().session_id, 2)
        .await
        .unwrap();
    let attachment = h.attachments.absolute_path(&content).unwrap();
    let mut permissions = std::fs::metadata(&attachment).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o600);
    }
    #[cfg(not(unix))]
    permissions.set_readonly(false);
    std::fs::set_permissions(&attachment, permissions).unwrap();
    std::fs::write(attachment, b"modified").unwrap();
    let before = h.events();
    assert!(
        h.generator()
            .generate(
                &h.context().session_id,
                "Summarize privately".into(),
                &Cancellation::default()
            )
            .await
            .is_ok()
    );
    assert_eq!(h.events(), before);
    let body = ycoding_schema::stringify_json(&h.server.seen.lock().unwrap()[0]);
    assert!(body.contains("Attached file unavailable: photo.png"));
    assert!(body.contains("Ask the user to attach the file again"));
    assert!(!body.contains("image_url"));
    h.close().await;
}

#[tokio::test]
async fn image_and_transient_generation_are_explicitly_cancellable_without_a_retry() {
    let h = Harness::new(
        TitleMode::Local,
        r#"{"image_analyzer":{"model":"openai/gpt-reasoning"}}"#,
    )
    .await;
    h.server.hold();
    let service = h.image();
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    let cancellation = Cancellation::default();
    let token = cancellation.clone();
    let task =
        tokio::spawn(async move { service.analyze(&[image()], Some(&info), None, &token).await });
    h.server.entered().await;
    cancellation.cancel();
    assert!(within(task).await.unwrap().is_err());
    assert_eq!(h.server.seen.lock().unwrap().len(), 1);
    assert!(h.ledger().is_empty());
    h.close().await;
}

struct GlobalLocations {
    local: Local,
    location: ycoding_schema::location::Ref,
}
impl ycoding_core::session::execution::Locations for GlobalLocations {
    fn get(
        &self,
        location: &ycoding_schema::location::Ref,
    ) -> Result<Arc<dyn ycoding_core::session::execution::Runner>, run_coordinator::Error> {
        if location != &self.location {
            return Err(run_coordinator::Error::Closed);
        }
        Ok(Arc::new(self.local.clone()))
    }
}
#[tokio::test]
async fn task_complete_real_registry_runner_and_execution_publish_one_receipt_after_final_text_settles()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Completion);
    h.prompt("Finish and verify", "first").await;
    let location = h
        .store
        .get(&h.context().session_id)
        .unwrap()
        .unwrap()
        .location;
    let local = Local::new(Services {
        store: h.store.clone(),
        location: location.clone(),
        models: h.models.models.clone(),
        agents: h.agents.clone(),
        credentials: h.models.credentials.clone(),
        tools: h.registry.clone(),
        attachments: h.attachments.clone(),
        instructions: vec![],
        analysis: None,
        clock: Arc::new(WallClock),
        executor: h.executor.clone(),
        compaction: Default::default(),
        guardrails: h.fixture.policy.guardrails.clone(),
        helpers: helper::Settings::default(),
        cursor: None,
        claude: None,
        auth: None,
        skill_resolver: None,
    });
    let execution = ycoding_core::session::execution::Execution::install(
        h.store.clone(),
        Arc::new(GlobalLocations { local, location }),
        h.jobs.clone(),
        None,
    )
    .unwrap();
    assert!(
        !h.events()
            .iter()
            .any(|event| event.type_.as_str() == Some("session.work.completed.1"))
    );
    within(execution.resume(&h.context().session_id))
        .await
        .unwrap();
    let events = h.events();
    let receipts = events
        .iter()
        .filter(|event| event.type_.as_str() == Some("session.work.completed.1"))
        .collect::<Vec<_>>();
    assert_eq!(receipts.len(), 1);
    let final_text = events
        .iter()
        .filter(|event| event.type_.as_str() == Some("session.text.ended.1"))
        .max_by_key(|event| event.seq)
        .unwrap();
    assert!(text(get(&final_text.data, "text")).contains("Completed and verified."));
    assert!(receipts[0].seq > final_text.seq);
    let declarations = events
        .iter()
        .filter(|event| {
            event.type_.as_str() == Some("session.tool.success.1")
                && get(get(&event.data, "structured"), "recorded") == &JsonValue::Bool(true)
        })
        .count();
    assert_eq!(declarations, 1);
    assert_eq!(h.server.seen.lock().unwrap().len(), 2);
    execution.shutdown().await.unwrap();
    h.close().await;
}

fn guarded(
    h: &Harness,
    decision: Option<ycoding_schema::guardrail::RuleDecision>,
    limit: u64,
    publish: ycoding_core::tools::policy::Publisher,
) -> Arc<ycoding_core::tools::context::policy::LeafPolicy> {
    let policy = h.fixture.policy.clone();
    let root = h.fixture.root.to_string_lossy().into_owned();
    let layers = Arc::new(move || {
        decision
            .map(|decision| {
                vec![ycoding_core::process::guardrails::CustomLayer {
                    rules: vec![ycoding_schema::guardrail::Rule {
                        id: "launch".into(),
                        source: ycoding_schema::guardrail::RuleSource::Custom,
                        decision,
                        actions: vec!["subagent".into()],
                        resources: vec!["*".into()],
                        reason: "Review the launch".into(),
                        priority: ycoding_schema::schema::Int::new(0).unwrap(),
                    }],
                    invalid_files: vec![],
                }]
            })
            .unwrap_or_default()
    });
    Arc::new(ycoding_core::tools::context::policy::LeafPolicy {
        permissions: policy.permissions.clone(),
        guardrails: ycoding_core::process::guardrails::Guardrails::new(
            h.fixture.authority.authority(),
            policy.permissions.clone(),
            ycoding_core::process::guardrails::Settings {
                paths: ycoding_core::process::guardrails::Paths {
                    workdir: root.as_str().into(),
                    project: root.as_str().into(),
                    home: root.as_str().into(),
                    tmpdir: None,
                    trusted_paths: vec![],
                },
                global_roots: vec![],
                custom: layers,
                enabled: true,
                limits: ycoding_core::process::guardrails::Limits {
                    subagents: limit,
                    ..Default::default()
                },
            },
            publish,
        ),
    })
}

#[tokio::test]
async fn subagent_custom_guardrail_deny_and_capacity_rejection_produce_no_child_job_activation_or_model_effect()
 {
    for (decision, capacity) in [
        (Some(ycoding_schema::guardrail::RuleDecision::Deny), 8),
        (None, 0),
    ] {
        let h = Harness::new(TitleMode::Local, "{}").await;
        let policy = guarded(&h, decision, capacity, h.fixture.authority.publisher());
        let registration = h
            .registry
            .register(
                vec![("subagent".into(), Arc::new(h.subagent(policy)))],
                Options::direct(),
            )
            .unwrap();
        let before = h.events();
        assert!(
            h.call(
                "subagent",
                r#"{"agent":"explore","description":"Review","prompt":"Review"}"#
            )
            .await
            .output
            .is_none()
        );
        assert_eq!(h.events(), before);
        assert!(
            h.orchestration
                .list(&h.context().session_id)
                .unwrap()
                .is_empty()
        );
        assert!(h.jobs.list().is_empty());
        assert!(h.activations.lock().unwrap().is_empty());
        assert!(h.server.seen.lock().unwrap().is_empty());
        drop(registration);
        h.close().await;
    }
}

#[tokio::test]
async fn cancelled_subagent_guardrail_review_releases_review_without_admitting_a_child() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let asked = Arc::new(Notify::new());
    let signal = asked.clone();
    let original = h.fixture.authority.publisher();
    let policy = guarded(
        &h,
        Some(ycoding_schema::guardrail::RuleDecision::HardReview),
        8,
        Arc::new(move |event| {
            let wake = event.type_ == "guardrail.asked";
            let result = original(event);
            if wake {
                signal.notify_one();
            }
            result
        }),
    );
    let registration = h
        .registry
        .register(
            vec![("subagent".into(), Arc::new(h.subagent(policy.clone())))],
            Options::direct(),
        )
        .unwrap();
    let context = h.context();
    let cancellation = context.cancellation.clone();
    let registry = h.registry.clone();
    let task = tokio::spawn(async move {
        registry
            .materialize(&[])
            .invoke(
                "subagent",
                parse_json(r#"{"agent":"explore","description":"Review","prompt":"Review"}"#)
                    .unwrap(),
                context,
            )
            .await
    });
    within(asked.notified()).await;
    let pending = policy
        .guardrails
        .for_session(&h.context().session_id)
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].hard_review, Some(true));
    assert_eq!(
        pending[0]
            .metadata
            .as_ref()
            .unwrap()
            .get(&"description".into()),
        Some(&JsonValue::String("Review".into()))
    );
    cancellation.cancel();
    assert!(within(task).await.unwrap().is_err());
    assert!(
        policy
            .guardrails
            .for_session(&h.context().session_id)
            .unwrap()
            .is_empty()
    );
    assert!(
        h.orchestration
            .list(&h.context().session_id)
            .unwrap()
            .is_empty()
    );
    assert!(h.jobs.list().is_empty());
    assert!(h.activations.lock().unwrap().is_empty());
    assert!(h.events().is_empty());
    assert!(h.server.seen.lock().unwrap().is_empty());
    drop(registration);
    h.close().await;
}

#[tokio::test]
async fn subagent_strict_model_input_rejects_unknown_properties_before_effect() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    assert!(h.call("subagent", r#"{"agent":"explore","description":"Review","prompt":"Review","model":{"providerID":"openai","id":"gpt-reasoning","unknown":"do-not-echo"}}"#).await.output.is_none());
    assert!(
        h.orchestration
            .list(&h.context().session_id)
            .unwrap()
            .is_empty()
    );
    assert!(h.events().is_empty());
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn cancelled_subagent_durable_admission_settles_before_cancelling_the_child() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let entered = Arc::new(Notify::new());
    let signal = entered.clone();
    let (release, released) = std::sync::mpsc::channel();
    let released = Mutex::new(Some(released));
    let client = h.fixture.authority.store.client();
    let original = h.fixture.authority.publisher();
    let blocker = Arc::new(Mutex::new(None));
    let blocked = blocker.clone();
    let policy = guarded(
        &h,
        None,
        8,
        Arc::new(move |event| {
            if event.type_ == "guardrail.decided" {
                let signal = signal.clone();
                let released = released.lock().unwrap().take().unwrap();
                let receipt = client
                    .submit(move |_| {
                        signal.notify_one();
                        released.recv().unwrap();
                        Ok(())
                    })
                    .unwrap();
                *blocked.lock().unwrap() = Some(tokio::spawn(receipt));
            }
            original(event)
        }),
    );
    let registration = h
        .registry
        .register(
            vec![("subagent".into(), Arc::new(h.subagent(policy)))],
            Options::direct(),
        )
        .unwrap();
    let context = h.context();
    let cancellation = context.cancellation.clone();
    let child = orchestration::Launch::new(
        &context.session_id,
        &context.message_id,
        context.call_id.as_str().unwrap(),
    )
    .child_id;
    let materialized = h.registry.materialize(&[]);
    let (result, ()) = tokio::join!(
        materialized.invoke(
            "subagent",
            parse_json(r#"{"agent":"explore","description":"Review","prompt":"Review"}"#).unwrap(),
            context
        ),
        async {
            within(entered.notified()).await;
            cancellation.cancel();
            tokio::task::yield_now().await;
            release.send(()).unwrap();
        },
    );
    assert!(result.is_err());
    let blocker = blocker.lock().unwrap().take().unwrap();
    within(blocker).await.unwrap().unwrap();
    h.fixture
        .authority
        .store
        .submit(|_| Ok(()))
        .unwrap()
        .await
        .unwrap();
    let task = h
        .orchestration
        .get(&h.context().session_id, &child)
        .unwrap();
    assert_eq!(
        get(&task.encode(), "state"),
        &JsonValue::String("cancelled".into())
    );
    assert!(h.store.get(&child).unwrap().is_some());
    assert!(h.jobs.list().is_empty());
    assert!(h.activations.lock().unwrap().is_empty());
    drop(registration);
    h.close().await;
}

#[tokio::test]
async fn helper_model_resolution_cancels_decision_title_image_and_generate_before_provider_effects()
{
    for kind in ["decision", "title", "image", "generate"] {
        let h = Harness::new(
            TitleMode::Model,
            r#"{"image_analyzer":{"model":"openai/gpt-reasoning"}}"#,
        )
        .await;
        h.prompt("First input", "first").await;
        h.models.credentials.create(
            "credential_fixture".into(), "openai".into(), None,
            ycoding_store::resources::Secret::new(parse_json(r#"{"type":"oauth","methodID":"chatgpt-browser","access":"fixture-access","refresh":"fixture-refresh","expires":1}"#).unwrap()).unwrap(),
            0,
        ).await.unwrap();
        let models = Arc::new(Models {
            models: h.models.models.clone(),
            credentials: h.models.credentials.clone(),
            auth: ycoding_core::resources::auth::Preparation {
                clients: BTreeMap::from([(
                    "openai".into(),
                    ycoding_core::resources::auth::Client::new(&h.server.url, "fixture").unwrap(),
                )]),
                cursor: None,
            },
            cursor: None,
            claude: None,
            store: h.store.clone(),
            settings: h.models.settings.clone(),
        });
        h.server.hold();
        let cancellation = Cancellation::default();
        let before = h.events();
        let generation = async {
            match kind {
                "decision" => {
                    let service = decision::Service {
                        store: h.store.clone(),
                        agents: h.agents.clone(),
                        models: models.clone(),
                        executor: h.executor.clone(),
                    };
                    assert_eq!(
                        service
                            .evaluate(
                                &parse_json(request()).unwrap(),
                                decision::Invocation {
                                    session_id: &h.context().session_id,
                                    input_id: None,
                                    cancellation: &cancellation
                                }
                            )
                            .await,
                        Err(decision::Error::Cancelled)
                    );
                }
                "title" => {
                    let service = title::Service::new(
                        h.store.clone(),
                        h.agents.clone(),
                        models.clone(),
                        h.executor.clone(),
                    );
                    service
                        .generate_for_first_prompt(
                            &h.store.get(&h.context().session_id).unwrap().unwrap(),
                            &cancellation,
                        )
                        .await
                        .unwrap();
                }
                "image" => {
                    let service = image_analyzer::Service::new(
                        h.config.clone(),
                        models.clone(),
                        h.executor.clone(),
                    );
                    assert_eq!(
                        service
                            .fallback_for_text_model(
                                &[image()],
                                &h.store.get(&h.context().session_id).unwrap().unwrap(),
                                None,
                                &cancellation
                            )
                            .await
                            .unwrap_err(),
                        "Image analysis cancelled"
                    );
                }
                _ => {
                    let mut service = h.generator();
                    service.models = models.clone();
                    assert!(matches!(
                        service
                            .generate(&h.context().session_id, "Generate".into(), &cancellation)
                            .await,
                        Err(generate::Error::Cancelled)
                    ));
                }
            }
        };
        let ((), ()) = tokio::join!(generation, async {
            h.server.entered().await;
            cancellation.cancel();
        });
        assert_eq!(h.events(), before, "{kind}");
        assert!(h.ledger().is_empty(), "{kind}");
        assert_eq!(h.server.seen.lock().unwrap().len(), 1, "{kind}");
        assert!(
            matches!(&h.server.seen.lock().unwrap()[0], JsonValue::String(body) if body.as_str().unwrap().contains("grant_type=refresh_token")),
            "{kind}"
        );
        h.models.credentials.shutdown().await.unwrap();
        h.close().await;
    }
}

#[tokio::test]
async fn concurrent_decision_requests_account_each_physical_attempt_with_distinct_ordered_ledger_ordinals()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Text(answer().into()));
    let gate = h.server.hold();
    let (first, second, ()) = tokio::join!(
        h.call("decision", request()),
        h.call("decision", request()),
        async {
            while h.server.seen.lock().unwrap().len() < 2 {
                h.server.entered().await;
            }
            gate.notify_waiters();
        }
    );
    assert!(first.output.is_some());
    assert!(second.output.is_some());
    let mut records = h.ledger();
    records.sort_by_key(|record| record.request);
    assert_eq!(
        records
            .iter()
            .map(|record| record.request)
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_ne!(records[0].id, records[1].id);
    assert_eq!(h.server.seen.lock().unwrap().len(), 2);
    assert_eq!(
        h.store
            .get(&h.context().session_id)
            .unwrap()
            .unwrap()
            .tokens
            .input
            .get(),
        16.0
    );
    h.close().await;
}

#[tokio::test]
async fn helper_stream_keeps_catalog_priced_zero_separate_from_unreported_price() {
    let h = Harness::new(TitleMode::Local, "{}").await;
    h.server.set(Reply::Text(answer().into()));
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    let agent = h.agents.get(&"decision".into()).unwrap();
    let mut resolved = h
        .models
        .role(&info, helper::Role::Decision, agent)
        .await
        .unwrap();
    resolved.info.cost = vec![
        ycoding_schema::model::Cost::decode(
            &parse_json(r#"{"input":0,"output":0,"cache":{"read":0,"write":0}}"#).unwrap(),
        )
        .unwrap(),
    ];
    let input_id = session_message::Id::new("msg_helper_input").unwrap();
    let request = helper::request(
        &info,
        &resolved,
        &agent.permissions,
        agent.system.iter().cloned().map(Into::into).collect(),
        vec![llm::Message::user("Judge")],
    );
    let streamed = helper::stream(
        &h.store,
        &h.executor,
        helper::StreamInput {
            session: &info,
            resolved: &resolved,
            agent,
            source: "decision",
            input_id: Some(&input_id),
            request,
            cancellation: &Cancellation::default(),
            byte_limit: Some(decision::judgment::BYTE_LIMIT),
            require_stop: true,
        },
    )
    .await
    .unwrap();
    assert!(!streamed.failed);
    assert!(streamed.tokens.is_some());
    assert_eq!(h.ledger()[0].cost, Some(0.0));
    assert_eq!(
        h.ledger()[0].input_id.as_ref().unwrap().as_str(),
        Some("msg_helper_input")
    );
    assert_eq!(h.ledger()[0].cache_read_reported, Some(1));
    h.close().await;
}

#[tokio::test]
async fn history_image_lowering_uses_verified_attachments_and_deduplicated_unexecuted_completed_tool_images()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let content = h.attachments.import(&[1, 2, 3]).unwrap();
    let user = session_message::Info::decode(
        &ObjectEncoder::new()
            .field("id", "msg_image")
            .field("type", "user")
            .field("text", "Inspect the image")
            .field(
                "files",
                &vec![
                    ObjectEncoder::new()
                        .field("content", &content)
                        .field("mime", "image/png")
                        .field("name", "photo.png")
                        .finish(),
                ],
            )
            .field(
                "time",
                &ObjectEncoder::new()
                    .field("created", &1.0)
                    .field("consumed", &1.0)
                    .finish(),
            )
            .finish(),
    )
    .unwrap();
    let assistant = session_message::Info::decode(&parse_json(r#"{"id":"msg_browser_image","type":"assistant","agent":"test","model":{"providerID":"openai","id":"gpt-reasoning"},"time":{"created":2,"completed":2},"content":[{"type":"tool","id":"call_image","name":"browser","executed":false,"time":{"created":2,"completed":2},"state":{"status":"completed","input":{},"structured":{},"content":[{"type":"file","uri":"data:image/png;base64,AQID","mime":"image/png","name":"screenshot.png"},{"type":"file","uri":"data:image/png;base64,AQID","mime":"image/png","name":"screenshot.png"}]}},{"type":"tool","id":"call_remote_image","name":"remote","executed":true,"time":{"created":2,"completed":2},"state":{"status":"completed","input":{},"structured":{},"content":[{"type":"file","uri":"data:image/png;base64,BAUG","mime":"image/png"}]}},{"type":"tool","id":"call_pending","name":"browser","time":{"created":2},"state":{"status":"running","input":{},"structured":{},"content":[{"type":"file","uri":"data:image/png;base64,BwgJ","mime":"image/png"}]}}]}"#).unwrap()).unwrap();
    let messages = vec![user, assistant];
    let collected = image_analyzer::collect(&messages, &h.attachments);
    assert_eq!(collected.inputs.len(), 2);
    assert_eq!(collected.tool_uris.len(), 1);
    assert_eq!(collected.inputs[0].bytes, [1, 2, 3]);
    assert_eq!(collected.inputs[1].bytes, [1, 2, 3]);
    let info = h.store.get(&h.context().session_id).unwrap().unwrap();
    let descriptions = h
        .image()
        .descriptions_for_history(
            &messages,
            &h.attachments,
            &info,
            None,
            &Cancellation::default(),
        )
        .await
        .unwrap()
        .unwrap();
    assert!(
        descriptions.tools["data:image/png;base64,AQID"].contains("image analyzer not configured")
    );
    let replay = generate::Replay {
        model: info.model.unwrap(),
        metadata_key: "openai".into(),
        accounts: Default::default(),
        states: Default::default(),
        descriptions: descriptions.attachments,
        tool_descriptions: descriptions.tools,
    };
    let lowered = generate::lower(&messages, &h.attachments, &replay);
    assert!(
        lowered
            .iter()
            .flat_map(|message| &message.content)
            .filter_map(|part| if let llm::Part::Text(text) = part {
                Some(text.text.to_utf8().unwrap())
            } else {
                None
            })
            .any(|text| text.contains("image analyzer not configured"))
    );
    let tool = lowered
        .iter()
        .find(|message| message.role == llm::Role::Tool)
        .unwrap();
    let llm::Part::ToolResult(result) = &tool.content[0] else {
        panic!()
    };
    assert!(format!("{:?}", result.result).contains("image analyzer not configured"));
    assert!(
        !lowered
            .iter()
            .flat_map(|message| &message.content)
            .any(|part| matches!(part, llm::Part::Media(_)))
    );
    assert!(h.server.seen.lock().unwrap().is_empty());
    h.close().await;
}

#[tokio::test]
async fn transient_generation_reads_session_instruction_entries_fresh_and_fences_the_location_without_mutation()
 {
    let h = Harness::new(TitleMode::Local, "{}").await;
    let mut generate = h.generator();
    let id = h.context().session_id;
    for guidance in ["Initial session guidance", "Revised session guidance"] {
        h.store
            .put_instruction_entry(
                &id,
                ycoding_schema::instruction_entry::Info::decode(
                    &ObjectEncoder::new()
                        .field("key", "guidance")
                        .field("value", guidance)
                        .finish(),
                )
                .unwrap(),
                1,
            )
            .await
            .unwrap();
        let before = h.events();
        let entries = h.store.instruction_entries(&id).unwrap();
        assert!(
            generate
                .generate(&id, "Private generation".into(), &Cancellation::default())
                .await
                .is_ok()
        );
        assert_eq!(h.events(), before);
        assert_eq!(h.store.instruction_entries(&id).unwrap(), entries);
        assert!(
            ycoding_schema::stringify_json(h.server.seen.lock().unwrap().last().unwrap())
                .contains(guidance)
        );
    }
    let before = h.events();
    generate.location = ycoding_schema::location::Ref::decode(
        &parse_json(r#"{"directory":"/another-location"}"#).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        generate
            .generate(&id, "Must not escape".into(), &Cancellation::default())
            .await,
        Err(generate::Error::Cancelled)
    ));
    assert_eq!(h.server.seen.lock().unwrap().len(), 2);
    assert_eq!(h.events(), before);
    assert!(h.ledger().is_empty());
    h.close().await;
}
