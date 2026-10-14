use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{mpsc, oneshot},
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        runner::{Local, Services, WallClock},
        skill::{InstructionsFuture, Resolver, SkillsFuture},
        store::Service,
    },
    tools::registry::Registry,
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json, session, session_message, session_pending, skill,
};
use ycoding_store::{Metadata, Options, Store, project, session as store_session};

pub const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
pub const TEXT_HEAD: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\n";
pub const WHITESPACE: &str = "data: {\"id\":\"ws\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"  \\n \"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"ws\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\n\ndata: [DONE]\n\n";
pub const EMPTY: &str = "data: {\"id\":\"empty\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":0}}\n\ndata: [DONE]\n\n";
pub const MALFORMED: &str = "data: not-json\n\n";
pub const TOOL: &str = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fixture\",\"type\":\"function\",\"function\":{\"name\":\"echo\",\"arguments\":\"{\\\"value\\\":\\\"observed\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
pub const RATE_LIMITED: &str = "{\"error\":{\"message\":\"rate limited\"}}";
pub const REJECTED: &str = "{\"error\":{\"message\":\"request rejected\"}}";

pub struct Root(pub PathBuf);
impl Root {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-session-flow-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    pub fn db(&self) -> PathBuf {
        self.0.join("store.redb")
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

type RunnerMap = Arc<
    std::sync::Mutex<
        std::collections::BTreeMap<String, Arc<dyn ycoding_core::session::execution::Runner>>,
    >,
>;

/// Scripted goal-continuation text source: each call pops the next queued reply,
/// and an empty queue declines to continue.
#[derive(Default)]
pub struct Steers {
    pub requests: std::sync::Mutex<std::collections::HashMap<session::Id, Vec<Option<String>>>>,
    pub replies: std::sync::Mutex<
        std::collections::HashMap<session::Id, std::collections::VecDeque<String>>,
    >,
}

impl ycoding_core::session::autonomy::Steer for Steers {
    fn steer(
        &self,
        request: ycoding_core::session::autonomy::SteerRequest,
    ) -> ycoding_core::session::autonomy::SteerFuture<'_> {
        self.requests
            .lock()
            .unwrap()
            .entry(request.session_id.clone())
            .or_default()
            .push(request.latest_assistant_text.clone());
        let reply = self
            .replies
            .lock()
            .unwrap()
            .get_mut(&request.session_id)
            .and_then(std::collections::VecDeque::pop_front);
        Box::pin(async move { reply })
    }
}

struct Placement(RunnerMap);
impl ycoding_core::session::execution::Locations for Placement {
    fn get(
        &self,
        location: &ycoding_schema::location::Ref,
    ) -> Result<
        Arc<dyn ycoding_core::session::execution::Runner>,
        ycoding_core::session::run_coordinator::Error,
    > {
        self.0
            .lock()
            .unwrap()
            .get(&location.directory.as_lossless().to_utf8().unwrap())
            .cloned()
            .ok_or(ycoding_core::session::run_coordinator::Error::Closed)
    }
}

/// Process-global Session execution over one file-backed store. Every test seeds its
/// own Sessions in its own Location directory and places a real Location runner there.
pub struct World {
    pub client: ycoding_store::Client,
    pub sessions: Service,
    pub jobs: ycoding_core::job::Jobs,
    pub execution: &'static ycoding_core::session::execution::Execution,
    pub steers: Arc<Steers>,
    runners: RunnerMap,
}

pub fn world() -> &'static World {
    static WORLD: std::sync::LazyLock<World> = std::sync::LazyLock::new(|| {
        let root: &'static Root = Box::leak(Box::new(Root::new()));
        build_world(file_store(root))
    });
    &WORLD
}

/// Installs the process-global Execution over `store`, which stays open for the life
/// of the process (subprocess workers end it abruptly).
pub fn build_world(store: Store) -> World {
    let client = store.client();
    let sessions = Service::new(client.clone());
    let jobs = ycoding_core::job::Jobs::new();
    let steers = Arc::new(Steers::default());
    let runners = RunnerMap::default();
    std::mem::forget(store);
    World {
        client,
        execution: ycoding_core::session::execution::Execution::install(
            sessions.clone(),
            Arc::new(Placement(runners.clone())),
            jobs.clone(),
            Some(steers.clone()),
        )
        .unwrap(),
        sessions,
        jobs,
        steers,
        runners,
    }
}

impl World {
    pub async fn publish(&self, id: &session::Id, type_: &str, fields: &str) {
        static EVENTS: AtomicU64 = AtomicU64::new(0);
        let fields = if fields.is_empty() {
            String::new()
        } else {
            format!(",{fields}")
        };
        self.sessions
            .publish(store_session::NewEvent {
                id: format!("evt_flow_{}", EVENTS.fetch_add(1, Ordering::SeqCst)).into(),
                aggregate_id: id.as_lossless().clone(),
                created: 20,
                type_: type_.into(),
                data: parse_json(&format!(
                    r#"{{"sessionID":"{}"{fields}}}"#,
                    id.as_lossless().as_str().unwrap()
                ))
                .unwrap(),
            })
            .await
            .unwrap();
    }

    /// A managed child task of `parent` that has started and has not settled.
    pub async fn running_child(&self, parent: &session::Id, call: &str) -> session::Id {
        let ids = ycoding_core::session::orchestration::Launch::new(
            parent,
            &session_message::Id::new("msg_parent").unwrap(),
            call,
        );
        let child = ids.child_id.clone();
        let mut row = record(child.as_lossless().as_str().unwrap());
        row.parent_id = Some(parent.as_lossless().clone());
        self.client
            .submit(move |tx| store_session::SessionTable::insert(tx, &row))
            .unwrap()
            .wait()
            .unwrap();
        self.publish(
            &child,
            "session.task.updated.1",
            &format!(
                r#""change":{{"type":"launched","parentID":"{}","parentAssistantMessageID":"msg_parent","toolCallID":"{call}","inputID":"{}","description":"child","agent":"reviewer","model":{{"providerID":"test","id":"test"}},"promptDigest":"digest","background":true,"delivery":"steer"}}"#,
                parent.as_lossless().as_str().unwrap(),
                ids.input_id.as_lossless().as_str().unwrap()
            ),
        )
        .await;
        self.publish(
            &child,
            "session.task.updated.1",
            r#""change":{"type":"started"}"#,
        )
        .await;
        child
    }

    pub fn seed(&self, id: &str, directory: &str) -> session::Id {
        let mut row = record(id);
        row.directory = directory.into();
        self.client
            .submit(move |tx| store_session::SessionTable::insert(tx, &row))
            .unwrap()
            .wait()
            .unwrap();
        session::Id::new(id).unwrap()
    }

    /// Places a real Location runner for `directory` that talks to `endpoint`.
    pub fn place(&self, directory: &str, endpoint: &str, registry: Arc<Registry>) {
        let local = local_full(
            &self.client,
            make_catalog(endpoint),
            vec![agent::empty("build".into())],
            registry,
            Arc::new(WallClock),
            directory,
            None,
        );
        self.runners
            .lock()
            .unwrap()
            .insert(directory.to_string(), Arc::new(local));
    }
}

pub fn record(id: &str) -> store_session::Session {
    store_session::Session {
        id: id.into(),
        project_id: "prj_one".into(),
        workspace_id: None,
        parent_id: None,
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/project".into(),
        path: None,
        title: "Test".into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
    }
}

pub fn catalog() -> ycoding_store::Catalog {
    ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core)
}

pub fn file_store(root: &Root) -> Store {
    let store = Store::initialize(
        root.db(),
        Options::core(),
        catalog(),
        Metadata::new([7; 16], 1),
    )
    .unwrap();
    seed(&store);
    store
}

pub fn reopen(root: &Root) -> Store {
    Store::open(root.db(), Options::core(), catalog()).unwrap()
}

pub fn seed(store: &Store) {
    store
        .submit(|tx| {
            if tx
                .get::<project::ProjectTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"prj_one".into()),
                ]))?
                .is_none()
            {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: "prj_one".into(),
                        worktree: "/project".into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: 1,
                        time_updated: 1,
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
            }
            for id in ["ses_one", "ses_two"] {
                if tx
                    .get::<store_session::SessionTable>(&ycoding_store::tuple_key(&[
                        ycoding_store::KeyPart::String(&id.into()),
                    ]))?
                    .is_none()
                {
                    store_session::SessionTable::insert(tx, &record(id))?;
                }
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

pub async fn server(
    replies: Vec<&'static str>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    server_status(replies.into_iter().map(|reply| (200, reply)).collect()).await
}

pub enum Reply {
    Status(u16, &'static str),
    /// Declares the full body length but sends only `prefix`, then closes the connection.
    Truncated(&'static str, &'static str),
    /// Records the request, then answers only after the barrier is released.
    Held(oneshot::Receiver<()>, &'static str),
}

pub async fn server_status(
    replies: Vec<(u16, &'static str)>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    server_replies(
        replies
            .into_iter()
            .map(|(status, reply)| Reply::Status(status, reply))
            .collect(),
    )
    .await
}

pub async fn server_replies(
    replies: Vec<Reply>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                if read == 0 {
                    break 0;
                }
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break boundary + 4;
                }
            };
            if boundary == 0 {
                return;
            }
            let header = std::str::from_utf8(&request[..boundary]).unwrap_or("");
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
            }
            let body = parse_json(
                std::str::from_utf8(&request[boundary..(boundary + length).min(request.len())])
                    .unwrap_or("{}"),
            )
            .unwrap_or(JsonValue::Null);
            let _ = send.send(body);
            let (status, declared, sent) = match reply {
                Reply::Status(status, body) => (status, body.len(), body),
                Reply::Truncated(prefix, rest) => (200, prefix.len() + rest.len(), prefix),
                Reply::Held(release, body) => {
                    let _ = release.await;
                    (200, body.len(), body)
                }
            };
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: {}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n{sent}",
                if status == 200 {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    (address, receive, task)
}

pub fn registry() -> Arc<Registry> {
    Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-session-flow-output"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ))
}

fn make_catalog(endpoint: &str) -> Catalog {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    catalog
}

pub fn local(store: &Store, endpoint: &str, registry: Arc<Registry>) -> Local {
    local_at(store, endpoint, registry, "/project")
}

pub fn local_at(store: &Store, endpoint: &str, registry: Arc<Registry>, directory: &str) -> Local {
    local_full(
        &store.client(),
        make_catalog(endpoint),
        vec![agent::empty("build".into())],
        registry,
        Arc::new(WallClock),
        directory,
        None,
    )
}

pub fn local_clock(
    store: &Store,
    endpoint: &str,
    registry: Arc<Registry>,
    clock: Arc<dyn ycoding_core::session::runner::Clock>,
) -> Local {
    local_full(
        &store.client(),
        make_catalog(endpoint),
        vec![agent::empty("build".into())],
        registry,
        clock,
        "/project",
        None,
    )
}

pub fn local_agents(
    store: &Store,
    endpoint: &str,
    registry: Arc<Registry>,
    agents: Vec<ycoding_schema::agent::Info>,
) -> Local {
    local_full(
        &store.client(),
        make_catalog(endpoint),
        agents,
        registry,
        Arc::new(WallClock),
        "/project",
        None,
    )
}

pub fn local_skills(
    store: &Store,
    endpoint: &str,
    registry: Arc<Registry>,
    resolver: Arc<dyn Resolver>,
) -> Local {
    local_full(
        &store.client(),
        make_catalog(endpoint),
        vec![agent::empty("build".into())],
        registry,
        Arc::new(WallClock),
        "/project",
        Some(resolver),
    )
}

fn guardrails(client: &ycoding_store::Client) -> ycoding_core::process::guardrails::Guardrails {
    policy(client).1
}

fn policy(
    client: &ycoding_store::Client,
) -> (
    ycoding_core::tools::policy::permissions::Permissions,
    ycoding_core::process::guardrails::Guardrails,
) {
    use ycoding_core::{
        process::guardrails::{Guardrails, Limits, Paths, Settings},
        tools::policy::{Authority, Publisher, permissions::Permissions},
    };
    let authority = Authority {
        store: client.clone(),
        agents: Arc::new(|agent| {
            Some((agent.cloned().unwrap_or_else(|| "build".into()), Vec::new()))
        }),
    };
    let publisher: Publisher = Arc::new(|_| Ok(()));
    let permissions = Permissions::new(
        authority.clone(),
        ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
        publisher.clone(),
    );
    let guardrails = Guardrails::new(
        authority,
        permissions.clone(),
        Settings {
            paths: Paths {
                workdir: "/project".into(),
                project: "/project".into(),
                home: "/home/operator".into(),
                tmpdir: None,
                trusted_paths: vec![],
            },
            global_roots: vec![],
            custom: Arc::new(Vec::new),
            enabled: true,
            limits: Limits::default(),
        },
        publisher,
    );
    (permissions, guardrails)
}

/// A registry with the real goal and task_complete tools over the given store.
pub fn session_tools_registry(client: &ycoding_store::Client) -> Arc<Registry> {
    use ycoding_core::tools::{
        builtin::{goal::Goal, task_complete::TaskComplete},
        context::policy::LeafPolicy,
        registry::Tool,
    };
    let registry = registry();
    let (permissions, guardrails) = policy(client);
    let entries: Vec<(String, Arc<dyn Tool>)> = vec![
        (
            "goal".into(),
            Arc::new(Goal {
                autonomy: ycoding_core::session::autonomy::Service::new(client.clone()),
                policy: Arc::new(LeafPolicy {
                    permissions,
                    guardrails,
                }),
            }),
        ),
        ("task_complete".into(), Arc::new(TaskComplete)),
    ];
    std::mem::forget(
        registry
            .register(entries, ycoding_core::tools::registry::Options::direct())
            .unwrap(),
    );
    registry
}

/// A registry whose `echo` tool appends the tool call identity to `marker`, a real
/// filesystem mutation that must never be replayed.
pub fn mutating_registry(marker: PathBuf) -> Arc<Registry> {
    let registry = registry();
    std::mem::forget(
        registry
            .register(
                vec![(
                    "echo".into(),
                    Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                        "Echo input and record the call",
                        parse_json(r#"{"type":"object"}"#).unwrap(),
                        None,
                        None,
                        move |input, context| {
                            let marker = marker.clone();
                            Box::pin(async move {
                                use std::io::Write;
                                let mut file = std::fs::OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(marker)
                                    .unwrap();
                                writeln!(file, "{}", context.call_id.to_utf8().unwrap()).unwrap();
                                file.sync_all().unwrap();
                                Ok(ycoding_ai::llm::ToolOutput {
                                    structured: input,
                                    content: Vec::new(),
                                })
                            })
                        },
                    )),
                )],
                ycoding_core::tools::registry::Options::direct(),
            )
            .unwrap(),
    );
    registry
}

pub fn tool_reply(name: &str, arguments: &str) -> &'static str {
    let arguments = ycoding_schema::stringify_json(&JsonValue::String(arguments.into()));
    Box::leak(
        format!(
            "data: {{\"id\":\"tool\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"call_{name}\",\"type\":\"function\",\"function\":{{\"name\":\"{name}\",\"arguments\":{arguments}}}}}]}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"tool\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\ndata: [DONE]\n\n"
        )
        .into_boxed_str(),
    )
}

pub fn reopen_at(directory: &std::path::Path) -> Store {
    Store::open(directory.join("store.redb"), Options::core(), catalog()).unwrap()
}

pub fn local_full(
    client: &ycoding_store::Client,
    catalog: Catalog,
    agents: Vec<ycoding_schema::agent::Info>,
    registry: Arc<Registry>,
    clock: Arc<dyn ycoding_core::session::runner::Clock>,
    directory: &str,
    skill_resolver: Option<Arc<dyn Resolver>>,
) -> Local {
    Local::new(Services {
        store: Service::new(client.clone()),
        events: ycoding_core::event_feed::Feed::attach(client),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(&format!(r#"{{"directory":"{directory}"}}"#)).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(agents)),
        credentials: credential::Service::new(client.clone()),
        tools: registry,
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-session-flow-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock,
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails(client),
        helpers: Default::default(),
        cursor: None,
        skill_resolver,
        snapshots: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        claude: None,
        auth: None,
    })
}

pub fn request(
    session: &str,
    id: &str,
    json: &str,
    event: &str,
) -> ycoding_core::session::pending::Request {
    ycoding_core::session::pending::Request {
        id: session_message::Id::new(id).unwrap(),
        session_id: session::Id::new(session).unwrap(),
        input: session_pending::Message::decode(&parse_json(json).unwrap()).unwrap(),
        event_id: ycoding_schema::event::Id::new(event).unwrap(),
        created: 10,
    }
}

pub async fn admit(service: &Service, session: &str, name: &str, text: &str, delivery: &str) {
    service
        .admit(request(
            session,
            &format!("msg_{name}"),
            &format!(
                r#"{{"type":"user","data":{{"text":{}}},"delivery":"{delivery}"}}"#,
                ycoding_schema::stringify_json(&JsonValue::String(text.into()))
            ),
            &format!("evt_{name}"),
        ))
        .await
        .unwrap();
}

pub fn event_types(store: &ycoding_store::Client, session: &str) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&session.into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|event| event.record.type_.as_str().unwrap().to_string())
        .collect()
}

pub fn event_seqs(store: &ycoding_store::Client, session: &str) -> Vec<i64> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&session.into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|event| event.record.seq)
        .collect()
}

pub fn count(types: &[String], kind: &str) -> usize {
    types
        .iter()
        .filter(|event| event.strip_suffix(".1") == Some(kind))
        .count()
}

pub fn user_texts(service: &Service, session: &str) -> Vec<String> {
    service
        .context(&session::Id::new(session).unwrap())
        .unwrap()
        .iter()
        .filter_map(|message| match message {
            ycoding_schema::session_message::Info::User(user) => Some(user.text.to_utf8().unwrap()),
            _ => None,
        })
        .collect()
}

pub struct FixtureSkills(pub Vec<skill::Info>);
impl Resolver for FixtureSkills {
    fn list(&self) -> SkillsFuture<'_> {
        let skills = self.0.clone();
        Box::pin(async move { Ok(skills) })
    }
    fn instructions<'a>(&'a self, info: &'a skill::Info) -> InstructionsFuture<'a> {
        Box::pin(async move {
            Ok(format!(
                "<skill_content name=\"{}\">\n{}\nBase directory: /skills/{}/\n</skill_content>",
                info.name.as_str().unwrap(),
                info.content.as_str().unwrap(),
                info.id.as_str().unwrap()
            )
            .into())
        })
    }
}

pub fn fixture_skill(id: &str, name: &str, content: &str) -> skill::Info {
    skill::Info::decode(
        &parse_json(&format!(
            r#"{{"id":"{id}","name":"{name}","location":"/skills/{id}/SKILL.md","content":"{content}"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

/// Registers an `echo` tool that first admits the given inputs (name, text, delivery)
/// into `session`, then returns its input. Returns the registry and registration guard.
pub fn admitting_echo(
    store: &Store,
    session: &'static str,
    inputs: Vec<(&'static str, &'static str, &'static str)>,
) -> (Arc<Registry>, Box<dyn std::any::Any>) {
    admitting_tool(store, session, inputs, false)
}

struct Ended(mpsc::UnboundedSender<()>);
impl Drop for Ended {
    fn drop(&mut self) {
        let _ = self.0.send(());
    }
}

/// Registers an `echo` tool that announces it started and then holds until cancelled.
/// `ended` receives one signal when the owned tool future is released, so tests can
/// prove cancellation joined the tool before the interruption settled.
pub fn held_echo(
    started: mpsc::UnboundedSender<()>,
    ended: mpsc::UnboundedSender<()>,
) -> (Arc<Registry>, Box<dyn std::any::Any>) {
    let registry = registry();
    let registration = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                    "Echo input",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    move |input, context| {
                        let started = started.clone();
                        let ended = Ended(ended.clone());
                        Box::pin(async move {
                            let _ended = ended;
                            started.send(()).unwrap();
                            context.cancellation.cancelled().await;
                            Ok(ycoding_ai::llm::ToolOutput {
                                structured: input,
                                content: Vec::new(),
                            })
                        })
                    },
                )),
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    (registry, Box::new(registration))
}

pub fn failing_echo(
    store: &Store,
    session: &'static str,
) -> (Arc<Registry>, Box<dyn std::any::Any>) {
    admitting_tool(store, session, Vec::new(), true)
}

fn admitting_tool(
    store: &Store,
    session: &'static str,
    inputs: Vec<(&'static str, &'static str, &'static str)>,
    fail: bool,
) -> (Arc<Registry>, Box<dyn std::any::Any>) {
    let registry = registry();
    let service = Service::new(store.client());
    let registration = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                    "Echo input",
                    parse_json(
                        r#"{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}"#,
                    )
                    .unwrap(),
                    None,
                    None,
                    move |input, _| {
                        let service = service.clone();
                        let inputs = inputs.clone();
                        Box::pin(async move {
                            if fail {
                                return Err(ycoding_core::tools::registry::Failure::message(
                                    "echo failed",
                                ));
                            }
                            for (name, text, delivery) in inputs {
                                admit(&service, session, name, text, delivery).await;
                            }
                            Ok(ycoding_ai::llm::ToolOutput {
                                structured: input,
                                content: Vec::new(),
                            })
                        })
                    },
                )),
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    (registry, Box::new(registration))
}
