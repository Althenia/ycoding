#![allow(dead_code)]

use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use ycoding_core::{
    event_feed::{Feed, Item, Payload, Scope as FeedScope, Subscriber},
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        credential, memory, model,
    },
    session::{
        autonomy,
        helper_generation::Dependencies,
        pending, prediction, prompt_generator,
        runner::{Local, Services, WallClock},
        store::Service as SessionStore,
    },
    tools::{
        policy::{
            Authority, Publisher,
            helper::{self, ModelSelection, Role},
            permissions::Permissions,
        },
        registry::Registry,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, LosslessString, parse_json, project_id::ProjectId,
    session, session_message, session_pending,
};
use ycoding_store::{
    Store,
    session::{Message, MessageTable, Pending, PendingTable, SessionTable},
};

#[path = "guardrails.rs"]
mod guardrails;

pub const SESSION: &str = "ses_one";

#[derive(Clone, Copy, Default, PartialEq)]
pub enum Memory {
    #[default]
    Available,
    OutsideGit,
    Unavailable,
}

#[derive(Default)]
pub struct Options {
    pub child: bool,
    pub goal: bool,
    pub pending: bool,
    pub compaction_pending: bool,
    pub running: bool,
    pub no_reply: bool,
    pub no_user: bool,
    pub user: Option<String>,
    pub assistant: Option<String>,
    pub directory: Option<&'static str>,
    pub memory: Memory,
    pub unresolvable_model: bool,
}

pub enum Reply {
    Text(String),
    Finish(String, &'static str),
    Rejected,
    Unsettled(String),
    Missing,
}

struct State {
    reply: Mutex<Reply>,
    gate: Mutex<Option<Arc<Notify>>>,
    seen: Mutex<Vec<JsonValue>>,
    started: Notify,
    closed: AtomicUsize,
}

#[derive(Clone)]
pub struct Provider {
    pub address: String,
    state: Arc<State>,
}

impl Provider {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let state = Arc::new(State {
            reply: Mutex::new(Reply::Text(String::new())),
            gate: Mutex::new(None),
            seen: Mutex::new(Vec::new()),
            started: Notify::new(),
            closed: AtomicUsize::new(0),
        });
        let address = format!("http://{}", listener.local_addr().unwrap());
        let shared = state.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                tokio::spawn(serve(stream, shared.clone()));
            }
        });
        Self { address, state }
    }

    pub fn reply(&self, reply: Reply) {
        *self.state.reply.lock().unwrap() = reply;
    }

    pub fn hold(&self) -> Arc<Notify> {
        let gate = Arc::new(Notify::new());
        *self.state.gate.lock().unwrap() = Some(gate.clone());
        gate
    }

    pub async fn started(&self) {
        tokio::time::timeout(Duration::from_secs(10), self.state.started.notified())
            .await
            .expect("the provider received no request");
    }

    pub fn seen(&self) -> Vec<JsonValue> {
        self.state.seen.lock().unwrap().clone()
    }

    pub async fn closed(&self, count: usize) {
        for _ in 0..200 {
            if self.state.closed.load(Ordering::SeqCst) >= count {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("the provider connection was not closed by the client");
    }
}

async fn serve(mut stream: tokio::net::TcpStream, state: Arc<State>) {
    let mut request = Vec::new();
    let mut buffer = [0u8; 4096];
    let boundary = loop {
        let read = stream.read(&mut buffer).await.unwrap();
        if read == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..read]);
        if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
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
        request.extend_from_slice(&buffer[..read]);
    }
    state.seen.lock().unwrap().push(
        parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap()).unwrap(),
    );
    state.started.notify_one();
    let gate = state.gate.lock().unwrap().clone();
    if let Some(gate) = gate {
        tokio::select! {
            _ = gate.notified() => {}
            read = stream.read(&mut buffer) => {
                if read.unwrap_or(0) == 0 {
                    state.closed.fetch_add(1, Ordering::SeqCst);
                    return;
                }
            }
        }
    }
    let (status, kind, body) = match &*state.reply.lock().unwrap() {
        Reply::Text(text) => (200, "text/event-stream", sse(text, "stop")),
        Reply::Finish(text, reason) => (200, "text/event-stream", sse(text, reason)),
        Reply::Rejected => (
            400,
            "application/json",
            r#"{"error":{"message":"rejected"}}"#.to_owned(),
        ),
        Reply::Unsettled(text) => (
            200,
            "text/event-stream",
            format!(
                "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\n",
                ycoding_schema::stringify_json(&JsonValue::String(text.as_str().into()))
            ),
        ),
        Reply::Missing => (200, "text/event-stream", "data: [DONE]\n\n".into()),
    };
    let response = format!(
        "HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

fn sse(text: &str, reason: &str) -> String {
    format!(
        "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"{reason}\"}}],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":5}}}}\n\ndata: [DONE]\n\n",
        ycoding_schema::stringify_json(&JsonValue::String(text.into()))
    )
}

pub struct Fixture {
    pub store: Store,
    pub provider: Provider,
    pub sessions: SessionStore,
    pub feed: Feed,
    pub dependencies: Dependencies,
    pub autonomy: autonomy::Service,
    pub access: Arc<Mutex<&'static str>>,
    pub acting: Arc<Mutex<Vec<Option<String>>>>,
    pub id: session::Id,
    directory: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

impl Fixture {
    pub async fn new(options: Options) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "ycoding-generation-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(directory.join("workspace/.git")).unwrap();
        let store = Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
            ycoding_store::Metadata::new([9; 16], 1),
        )
        .unwrap();
        seed(&store, &options);
        let provider = Provider::start().await;
        let sessions = SessionStore::new(store.client());
        let feed = Feed::attach(&store.client());
        let access = Arc::new(Mutex::new("allow"));
        let acting = Arc::new(Mutex::new(Vec::new()));
        let authority = Authority {
            store: store.client(),
            agents: {
                let access = access.clone();
                let acting = acting.clone();
                Arc::new(move |agent| {
                    acting
                        .lock()
                        .unwrap()
                        .push(agent.and_then(|agent| agent.to_utf8().ok()));
                    let rule = format!(
                        r#"[{{"action":"memory_read","resource":"*","effect":"{}"}}]"#,
                        access.lock().unwrap()
                    );
                    Some((
                        agent.cloned().unwrap_or_else(|| "build".into()),
                        Vec::<ycoding_schema::permission::Rule>::decode(
                            &parse_json(&rule).unwrap(),
                        )
                        .unwrap(),
                    ))
                })
            },
        };
        let publisher: Publisher = Arc::new(|_| Ok(()));
        let permissions =
            Permissions::new(authority, ProjectId::new("prj_one").unwrap(), publisher);
        let dependencies = Dependencies {
            store: sessions.clone(),
            agents: Arc::new(agent::Service::new(vec![
                agent::empty("build".into()),
                prediction::agent(),
                prompt_generator::agent(),
            ])),
            generate: Arc::new(local(&store, &provider.address, options.unresolvable_model)),
            memory: Arc::new(memory_service(&directory, options.memory).await),
            permissions,
            feed: feed.clone(),
            location: ycoding_schema::location::Ref::decode(
                &parse_json(r#"{"directory":"/project"}"#).unwrap(),
            )
            .unwrap(),
        };
        Self {
            sessions,
            feed,
            dependencies,
            autonomy: autonomy::Service::new(store.client()),
            access,
            acting,
            id: session::Id::new(SESSION).unwrap(),
            provider,
            store,
            directory,
        }
    }

    pub fn prediction(&self) -> prediction::Service {
        prediction::Service::new(self.dependencies.clone(), self.autonomy.clone())
    }

    pub fn prompts(&self) -> prompt_generator::Service {
        prompt_generator::Service::new(self.dependencies.clone())
    }

    pub fn observe(&self) -> Subscriber {
        self.feed.subscribe(FeedScope::Global, None, || {}).unwrap()
    }

    pub async fn publish(&self, kind: &str, data: &str) {
        self.sessions
            .publish(ycoding_store::session::NewEvent {
                id: format!("evt_{}", kind.replace('.', "_")).into(),
                aggregate_id: SESSION.into(),
                created: 50,
                type_: kind.into(),
                data: parse_json(data).unwrap(),
            })
            .await
            .unwrap();
    }

    pub async fn admit(&self, text: &str) {
        self.sessions
            .admit(pending::Request {
                id: session_message::Id::new("msg_next").unwrap(),
                session_id: self.id.clone(),
                input: session_pending::Message::decode(
                    &parse_json(&format!(
                        r#"{{"type":"user","data":{{"text":{}}},"delivery":"steer"}}"#,
                        ycoding_schema::stringify_json(&JsonValue::String(text.into()))
                    ))
                    .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new("evt_next").unwrap(),
                created: 60,
            })
            .await
            .unwrap();
    }

    pub fn ledger(&self) -> Vec<(String, JsonValue)> {
        ycoding_store::resources::requests(
            &self.store.snapshot().unwrap(),
            &LosslessString::from(SESSION),
            ycoding_store::IndexOrder::Ascending,
            None,
            100,
        )
        .unwrap()
        .into_iter()
        .map(|entry| {
            let tokens: ycoding_schema::token_usage::Info = entry.record.tokens.domain().unwrap();
            (entry.record.source.to_utf8().unwrap(), tokens.encode())
        })
        .collect()
    }

    pub fn sessions_context(&self) -> Vec<String> {
        self.sessions
            .context(&self.id)
            .unwrap()
            .iter()
            .map(|message| match message {
                session_message::Info::User(_) => "user",
                session_message::Info::Assistant(_) => "assistant",
                _ => "other",
            })
            .map(str::to_owned)
            .collect()
    }

    pub fn helper_message(&self, index: usize) -> JsonValue {
        let JsonValue::Object(body) = &self.provider.seen()[index] else {
            panic!("request body is an object")
        };
        let Some(JsonValue::Array(messages)) = body.get(&"messages".into()) else {
            panic!("request has messages")
        };
        let Some(JsonValue::Object(last)) = messages.last() else {
            panic!("request has a final message")
        };
        let Some(JsonValue::String(content)) = last.get(&"content".into()) else {
            panic!("final message content is text")
        };
        parse_json(&content.to_utf8().unwrap()).unwrap()
    }

    pub fn helper_system(&self, index: usize) -> String {
        let JsonValue::Object(body) = &self.provider.seen()[index] else {
            panic!("request body is an object")
        };
        let Some(JsonValue::Array(messages)) = body.get(&"messages".into()) else {
            panic!("request has messages")
        };
        let Some(JsonValue::Object(first)) = messages.first() else {
            panic!("request has a system message")
        };
        ycoding_schema::stringify_json(first.get(&"content".into()).unwrap())
    }
}

pub fn drain(subscriber: &Subscriber) -> Vec<Arc<Item>> {
    std::iter::from_fn(|| subscriber.next().unwrap()).collect()
}

pub fn predictions(items: &[Arc<Item>]) -> Vec<JsonValue> {
    items
        .iter()
        .filter_map(|item| match &item.payload {
            Payload::Ephemeral(event) if event.data.name() == "session.prediction.updated" => {
                Some(ycoding_schema::DomainEncode::encode(&event.data))
            }
            _ => None,
        })
        .collect()
}

pub fn field(value: &JsonValue, key: &str) -> JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected an object")
    };
    object.get(&key.into()).cloned().unwrap_or(JsonValue::Null)
}

pub fn text(value: &JsonValue) -> String {
    let JsonValue::String(text) = value else {
        panic!("expected a string, found {value:?}")
    };
    text.to_utf8().unwrap()
}

fn seed(store: &Store, options: &Options) {
    let options_directory = options.directory.unwrap_or("/project");
    let child = options.child;
    let goal = options.goal;
    let user = options
        .user
        .clone()
        .unwrap_or_else(|| "Fix the failing build".into());
    let assistant = options
        .assistant
        .clone()
        .unwrap_or_else(|| "The build is fixed.".into());
    let (running, no_reply, no_user, compaction) = (
        options.running,
        options.no_reply,
        options.no_user,
        options.compaction_pending,
    );
    store
        .submit(move |tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
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
            SessionTable::insert(
                tx,
                &ycoding_store::session::Session {
                    id: SESSION.into(),
                    project_id: "prj_one".into(),
                    workspace_id: None,
                    parent_id: child.then(|| "ses_parent".into()),
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    directory: options_directory.into(),
                    path: None,
                    title: "Helper".into(),
                    cost: 0.0,
                    tokens_input: 0,
                    tokens_output: 0,
                    tokens_reasoning: 0,
                    tokens_cache_read: 0,
                    tokens_cache_write: 0,
                    revert: None,
                    permission: None,
                    autonomy: goal.then(|| {
                        parse_json(r#"{"mode":"normal","yolo":0,"goal":{"text":"Finish","status":"active","iteration":0,"noProgress":0,"maxNoProgress":3}}"#).unwrap()
                    }),
                    autonomy_revision: 0,
                    orchestration_revision: 0,
                    agent: Some("build".into()),
                    model: None,
                    profile_binding: None,
                    daybreak: None,
                    time_created: 1,
                    time_updated: 1,
                    time_archived: None,
                    time_active: None,
                    time_pinned: None,
                    time_suspended: None,
                },
            )?;
            let mut seq = 0;
            if !no_user {
                seq += 1;
                MessageTable::insert(
                    tx,
                    &Message {
                        id: "msg_user".into(),
                        session_id: SESSION.into(),
                        type_: "user".into(),
                        seq,
                        time_created: seq,
                        time_updated: seq,
                        data: parse_json(&format!(
                            r#"{{"text":{},"time":{{"created":1,"consumed":1}}}}"#,
                            ycoding_schema::stringify_json(&JsonValue::String(user.as_str().into()))
                        ))
                        .unwrap(),
                    },
                )?;
            }
            if !no_reply && !no_user {
                seq += 1;
                let completed = if running { "" } else { r#","completed":2"# };
                MessageTable::insert(
                    tx,
                    &Message {
                        id: "msg_assistant".into(),
                        session_id: SESSION.into(),
                        type_: "assistant".into(),
                        seq,
                        time_created: seq,
                        time_updated: seq,
                        data: parse_json(&format!(
                            r#"{{"agent":"build","model":{{"providerID":"openai","id":"gpt-reasoning"}},"content":[{{"type":"text","text":{}}}],"time":{{"created":2{completed}}}}}"#,
                            ycoding_schema::stringify_json(&JsonValue::String(
                                assistant.as_str().into()
                            ))
                        ))
                        .unwrap(),
                    },
                )?;
            }
            ycoding_store::session::SequenceTable::put(
                tx,
                &ycoding_store::session::Sequence {
                    aggregate_id: SESSION.into(),
                    seq,
                    owner_id: None,
                },
            )?;
            if compaction {
                PendingTable::insert(
                    tx,
                    &Pending {
                        id: "msg_compaction".into(),
                        session_id: SESSION.into(),
                        type_: "compaction".into(),
                        data: parse_json("{}").unwrap(),
                        delivery: None,
                        admitted_seq: 1,
                        time_created: 10,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}

async fn memory_service(directory: &std::path::Path, mode: Memory) -> memory::Service {
    let workspace = directory.join("workspace");
    let service = memory::Service::new(memory::Options {
        directory: if mode == Memory::Unavailable {
            directory.join("missing")
        } else {
            workspace.clone()
        },
        home: directory.to_path_buf(),
        data: directory.join("data"),
        repository: (mode != Memory::OutsideGit).then(|| memory::Repository {
            directory: workspace.clone(),
            common_directory: workspace.join(".git"),
            worktrees: vec![workspace.clone()],
        }),
        limits: memory::Limits::default(),
    })
    .unwrap();
    if mode == Memory::Unavailable {
        return service;
    }
    for scope in [memory::Scope::Repository, memory::Scope::Knowledge]
        .into_iter()
        .filter(|scope| mode != Memory::OutsideGit || *scope == memory::Scope::Knowledge)
    {
        for index in 0..4 {
            service
                .write(
                    scope,
                    &format!("testing/rule-{index}"),
                    &format!(
                        "---\ntype: Gotcha\ntitle: Test rule {index}\n---\nbuild {}\n",
                        "x".repeat(900)
                    ),
                    None,
                )
                .await
                .unwrap();
        }
    }
    service
}

fn local(store: &Store, endpoint: &str, unresolvable_model: bool) -> Local {
    let selected = ModelSelection::Model(
        ycoding_schema::model::Ref::decode(
            &parse_json(if unresolvable_model {
                r#"{"providerID":"missing","id":"none"}"#
            } else {
                r#"{"providerID":"openai","id":"gpt-reasoning"}"#
            })
            .unwrap(),
        )
        .unwrap(),
    );
    local_with_settings(
        store,
        endpoint,
        helper::Settings {
            models: BTreeMap::from([
                (Role::Prediction, selected.clone()),
                (Role::Prompt, selected),
            ]),
            ..helper::Settings::default()
        },
    )
}

pub fn local_with_settings(store: &Store, endpoint: &str, helpers: helper::Settings) -> Local {
    let models =
        include_str!("../../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json");
    let mut source = parse_json(models).unwrap();
    let JsonValue::Object(providers) = &mut source else {
        panic!("provider fixture object")
    };
    let JsonValue::Object(mut provider) = providers.get(&"openai".into()).unwrap().clone() else {
        panic!("OpenAI fixture object")
    };
    let JsonValue::Object(mut models) = provider.get(&"models".into()).unwrap().clone() else {
        panic!("model fixture object")
    };
    let original = models.get(&"gpt-reasoning".into()).unwrap().clone();
    for id in ["goal-agent", "goal-role", "goal-session"] {
        let JsonValue::Object(mut model) = original.clone() else {
            panic!("model fixture object")
        };
        model.insert("id".into(), JsonValue::String(id.into()));
        model.insert(
            "cost".into(),
            parse_json(r#"{"input":2,"output":4}"#).unwrap(),
        );
        models.insert(id.into(), JsonValue::Object(model));
    }
    provider.insert("models".into(), JsonValue::Object(models));
    providers.insert("openai".into(), JsonValue::Object(provider));
    let mut catalog = Catalog::new(models_dev::normalize(&source).unwrap());
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    let scratch =
        std::env::temp_dir().join(format!("ycoding-generation-scratch-{}", std::process::id()));
    Local::new(Services {
        snapshots: None,
        store: SessionStore::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(store.client()),
        tools: Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &ycoding_core::resources::config::Roots::development(&scratch.join("output"))
                    .unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(attachment_store::Store::new(scratch.join("attachments")).unwrap()),
        instructions: Vec::new(),
        analysis: None,
        cursor: None,
        skill_resolver: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        claude: None,
        auth: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: ycoding_core::session::compaction_policy::resolve(&[]),
        guardrails: guardrails::guardrails(store),
        helpers,
    })
}
