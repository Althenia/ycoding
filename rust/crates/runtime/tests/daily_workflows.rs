#[path = "support/production_owner.rs"]
mod production_owner;

mod support;

use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use ycoding_core::{
    job::StartInput,
    resources::{catalog::models_dev, config},
    session::pending,
    tools::context::Context,
    ycoding_schema::{
        DomainDecode, JsonValue, event, form, parse_json, permission, session, session_message,
        session_pending, stringify_json,
    },
    ycoding_store::{
        KeyPart, Metadata, Options, Store,
        native::{DatabaseKind, catalog},
        project,
        session::{Document, EventTable, SessionTable, Task, TaskTable},
        tuple_key,
    },
};
use ycoding_runtime::{Core, Production};

const MODELS: &str = r#"{"openai":{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192}}}}}"#;
const ROOT: &str = "YCODING_DAILY_WORKFLOW_ROOT";
const PHASE: &str = "YCODING_DAILY_WORKFLOW_PHASE";
const SYNTHETIC_KEY: &str = "synthetic-daily-workflow-key";
const PENDING_APPROVAL: &str = "DAILY_WORKFLOW_PENDING_APPROVAL";
const INHERITED: [&str; 10] = [
    "PATH",
    "SHELL",
    "TZ",
    "LANG",
    "LC_ALL",
    "RUST_BACKTRACE",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
];
const SESSION: &str = "ses_daily";
static NEXT: AtomicU64 = AtomicU64::new(0);
const PARENT: &str = "ses_daily_parent";
const CHILD: &str = "ses_daily_child";
const QUESTION: &str = r#"{"questions":[{"question":"Which color should the banner use?","header":"Banner color","options":[{"label":"Blue","description":"Use blue"},{"label":"Green","description":"Use green"}]}]}"#;

#[test]
fn a_required_question_outlives_the_retired_expiry_setting_and_resumes_only_with_its_answer() {
    isolated(
        "a_required_question_outlives_the_retired_expiry_setting_and_resumes_only_with_its_answer",
        &["question"],
        |_, root| run(|host| Box::pin(question_flow(host, root))),
    );
}

#[test]
fn a_child_question_stays_waiting_for_its_parent_past_the_retired_expiry_setting() {
    isolated(
        "a_child_question_stays_waiting_for_its_parent_past_the_retired_expiry_setting",
        &["child-question"],
        |_, root| run(|host| Box::pin(child_question_flow(host, root))),
    );
}

#[test]
fn an_approved_effect_settles_once_and_a_crash_with_a_pending_approval_replays_nothing() {
    let name =
        "an_approved_effect_settles_once_and_a_crash_with_a_pending_approval_replays_nothing";
    if let Some((root, phase)) = assigned() {
        return match phase.as_str() {
            "approve" => run(|host| Box::pin(approval_flow(host, root))),
            "restart" => run(|host| Box::pin(restart_flow(host, root))),
            other => panic!("unknown phase {other}"),
        };
    }
    let root = Disposable::new();
    let mut crashed = child(name, "approve", &root.0)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(crashed.stdout.take().unwrap()).lines();
    assert!(
        lines.any(|line| line.unwrap() == PENDING_APPROVAL),
        "the first runtime exited before its second approval was pending"
    );
    crashed.kill().unwrap();
    crashed.wait().unwrap();
    assert!(child(name, "restart", &root.0).status().unwrap().success());
}

async fn question_flow(host: &production_owner::Host, root: PathBuf) {
    let provider = Provider::start(vec![
        tool_call("call_question", "question", QUESTION),
        text("Using blue"),
    ])
    .await;
    let (_store, core) = boot(
        host,
        &root,
        &provider.endpoint,
        r#","question_timeout_seconds":1"#,
        &[(SESSION, None)],
        false,
    )
    .await;
    let id = id(SESSION);
    admit(&core, SESSION, "msg_daily_question", "Pick a banner color").await;
    let running = resume(&core, SESSION);
    let (_, services) = core.locations.session(&id).unwrap();
    let asked = until(|| {
        services
            .forms
            .list(Some(id.as_lossless()))
            .into_iter()
            .next()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    assert!(
        matches!(
            services.forms.state(&asked.id).unwrap(),
            form::State::Pending
        ),
        "elapsed time must not settle a required question"
    );
    assert_eq!(
        provider.bodies().len(),
        1,
        "dependent work must not resume before the answer"
    );
    services
        .forms
        .reply(
            &asked.id,
            form::Answer::decode(&parse_json(r#"{"q0":"Blue"}"#).unwrap()).unwrap(),
        )
        .unwrap();
    running.await.unwrap().unwrap();
    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 2);
    assert!(bodies[1].contains(r#""tool_call_id":"call_question""#));
    assert!(bodies[1].contains("=\\\"Blue\\\""), "{}", bodies[1]);
    assert!(!bodies[1].contains("own best judgment"), "{}", bodies[1]);
    core.shutdown().await.unwrap();
    provider.stop().await;
}

async fn child_question_flow(host: &production_owner::Host, root: PathBuf) {
    let provider = Provider::start(vec![]).await;
    let (store, core) = boot(
        host,
        &root,
        &provider.endpoint,
        r#","question_timeout_seconds":1"#,
        &[(PARENT, None), (CHILD, Some(PARENT))],
        false,
    )
    .await;
    let task = waiting_task();
    store
        .submit(move |tx| TaskTable::put(tx, &task))
        .unwrap()
        .wait()
        .unwrap();
    core.execution
        .jobs()
        .start(StartInput {
            id: Some(CHILD.into()),
            kind: "subagent".into(),
            title: None,
            metadata: None,
            run: Box::pin(std::future::pending()),
        })
        .unwrap();
    let (_, services) = core.locations.session(&id(CHILD)).unwrap();
    let agents = services.agents.snapshot();
    let agent = agents.default().unwrap();
    let settlement = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&agent.permissions)
        .invoke(
            "subagent_report",
            parse_json(r#"{"action":"question","text":"Which branch should the child use?"}"#)
                .unwrap(),
            Context::new(
                CHILD,
                agent.id.as_str().unwrap(),
                "msg_daily_child_report",
                "call_daily_child_report",
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(settlement.error.is_none(), "{:?}", settlement.error);
    let question = task_row(&store).question_id;
    assert!(
        question.is_some(),
        "the child question must wait for its parent"
    );
    tokio::time::sleep(Duration::from_millis(2_500)).await;
    let row = task_row(&store);
    assert_eq!(row.state.as_str(), Some("waiting"));
    assert_eq!(
        row.question_id, question,
        "elapsed time must not close a required child question"
    );
    assert!(
        !events(&store, CHILD).iter().any(|(kind, data)| {
            kind.starts_with("session.input.admitted") && data.contains("subagent_parent")
        }),
        "no answer or no-answer steer may reach the child without its parent"
    );
    assert!(core.execution.jobs().cancel(CHILD).await.is_some());
    core.shutdown().await.unwrap();
    provider.stop().await;
}

async fn approval_flow(host: &production_owner::Host, root: PathBuf) {
    let provider = Provider::start(vec![
        tool_call(
            "call_approved",
            "shell",
            r#"{"command":"printf approved >> approved.marker"}"#,
        ),
        text("Approved effect finished"),
        tool_call(
            "call_pending",
            "shell",
            r#"{"command":"printf pending >> pending.marker"}"#,
        ),
    ])
    .await;
    let (_store, core) = boot(
        host,
        &root,
        &provider.endpoint,
        SHELL_ASKS,
        &[(SESSION, None)],
        false,
    )
    .await;
    let id = id(SESSION);
    let project = root.join("project");
    let (_, services) = core.locations.session(&id).unwrap();

    admit(
        &core,
        SESSION,
        "msg_daily_approved",
        "Record the approved marker",
    )
    .await;
    let running = resume(&core, SESSION);
    let asked = tokio::time::timeout(
        Duration::from_secs(20),
        until(|| services.permissions.for_session(&id).into_iter().next()),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "no approval request: guardrails={:?} requests={} events={:?}",
            services
                .guardrails
                .for_session(&id)
                .map(|items| items.len()),
            provider.bodies().len(),
            events(&_store, SESSION)
                .iter()
                .map(|(kind, data)| format!("{kind} {}", &data[..data.len().min(300)]))
                .collect::<Vec<_>>()
        )
    });
    assert!(
        !project.join("approved.marker").exists(),
        "the effect must wait for approval"
    );
    services
        .permissions
        .reply(&asked.id, permission::Reply("once".into()), None)
        .unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(
        std::fs::read_to_string(project.join("approved.marker")).unwrap(),
        "approved"
    );
    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 2);
    assert!(bodies[1].contains(r#""tool_call_id":"call_approved""#));

    admit(
        &core,
        SESSION,
        "msg_daily_pending",
        "Record the pending marker",
    )
    .await;
    let _running = resume(&core, SESSION);
    until(|| services.permissions.for_session(&id).into_iter().next()).await;
    assert!(!project.join("pending.marker").exists());
    println!("\n{PENDING_APPROVAL}");
    std::future::pending::<()>().await;
}

async fn restart_flow(host: &production_owner::Host, root: PathBuf) {
    let provider = Provider::start(vec![text("Recovered after restart")]).await;
    let (store, core) = boot(host, &root, &provider.endpoint, SHELL_ASKS, &[], true).await;
    let id = id(SESSION);
    let project = root.join("project");
    let (_, services) = core.locations.session(&id).unwrap();
    assert!(
        services.permissions.for_session(&id).is_empty(),
        "restart must not restore a pending approval"
    );
    assert!(
        provider.bodies().is_empty(),
        "restart must not replay a provider attempt"
    );
    assert!(
        events(&store, SESSION).iter().any(|(kind, data)| {
            kind.starts_with("session.execution.failed") && data.contains("interrupted")
        }),
        "restart must settle the crashed execution as interrupted"
    );

    admit(
        &core,
        SESSION,
        "msg_daily_after_restart",
        "Continue after restart",
    )
    .await;
    resume(&core, SESSION).await.unwrap().unwrap();
    let bodies = provider.bodies();
    assert_eq!(bodies.len(), 1);
    assert!(
        !bodies[0].contains(r#""id":"call_pending""#)
            || bodies[0].contains(r#""tool_call_id":"call_pending""#),
        "an interrupted tool call must reach the provider settled"
    );
    assert_eq!(
        std::fs::read_to_string(project.join("approved.marker")).unwrap(),
        "approved"
    );
    assert!(
        !project.join("pending.marker").exists(),
        "an unapproved effect must never run after restart"
    );
    core.shutdown().await.unwrap();
    provider.stop().await;
}

const SHELL_ASKS: &str = r#","permissions":[{"action":"shell","resource":"*","effect":"ask"}],"guardrails":{"decide_reviews":false}"#;

async fn boot(
    host: &production_owner::Host,
    root: &Path,
    endpoint: &str,
    extra: &str,
    sessions: &[(&str, Option<&str>)],
    existing: bool,
) -> (ycoding_core::ycoding_store::Client, Core) {
    let roots = config::Roots::development(root).unwrap();
    roots.initialize().unwrap();
    let directory = root.join("project");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("ycoding.json"),
        format!(
            r#"{{"model":{{"providerID":"openai","model":"gpt-runtime"}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}}{extra}}}"#
        ),
    )
    .unwrap();
    let path = root.join("store.redb");
    let store = host.retain(
        if existing {
            Store::open(path, Options::core(), catalog(DatabaseKind::Core)).unwrap()
        } else {
            Store::initialize(
                path,
                Options::core(),
                catalog(DatabaseKind::Core),
                Metadata::new([41; 16], 1),
            )
            .unwrap()
        },
        None,
    );
    let placement = directory.to_str().unwrap().to_owned();
    let rows = sessions
        .iter()
        .map(|(id, parent)| {
            let mut row = support::record(id);
            row.directory = placement.as_str().into();
            row.parent_id = parent.map(Into::into);
            row.time_created = now();
            row.time_updated = now();
            row
        })
        .collect::<Vec<_>>();
    if !existing {
        store
            .submit(move |tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: "prj_one".into(),
                        worktree: placement.as_str().into(),
                        vcs: None,
                        name: None,
                        icon_url: None,
                        icon_url_override: None,
                        icon_color: None,
                        time_created: now(),
                        time_updated: now(),
                        time_initialized: None,
                        sandboxes: vec![],
                        commands: None,
                    },
                )?;
                rows.iter()
                    .try_for_each(|row| SessionTable::insert(tx, row))
            })
            .unwrap()
            .wait()
            .unwrap();
    }
    let core = Core::production(
        &host.owner,
        store.clone(),
        Production {
            analytics: roots.data.join("analytics"),
            configuration: config::LoadOptions {
                directory,
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env: BTreeMap::from([("OPENAI_API_KEY".into(), SYNTHETIC_KEY.into())]),
            },
            catalog: models_dev::Options {
                source: "https://models.dev".into(),
                cache: roots.cache.join("models.json"),
                file: None,
                bundled: Some(parse_json(MODELS).unwrap()),
                fetch: false,
                user_agent: "ycoding-test".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: false,
        },
    )
    .await
    .unwrap();
    (store, core)
}

async fn admit(core: &Core, session: &str, message: &str, text: &str) {
    core.execution
        .prompt(
            pending::Request {
                id: session_message::Id::new(message).unwrap(),
                session_id: id(session),
                input: session_pending::Message::decode(
                    &parse_json(&format!(
                        r#"{{"type":"user","data":{{"text":{}}},"delivery":"steer"}}"#,
                        stringify_json(&JsonValue::String(text.into()))
                    ))
                    .unwrap(),
                )
                .unwrap(),
                event_id: event::Id::new(format!("evt_{message}")).unwrap(),
                created: now(),
            },
            Some(false),
        )
        .await
        .unwrap();
}

fn resume(
    core: &Core,
    session: &str,
) -> tokio::task::JoinHandle<ycoding_core::session::run_coordinator::Outcome> {
    let execution = core.execution;
    let session = id(session);
    tokio::spawn(async move { execution.resume(&session).await })
}

async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    loop {
        if let Some(value) = probe() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn waiting_task() -> Task {
    Task {
        session_id: CHILD.into(),
        parent_id: PARENT.into(),
        parent_assistant_message_id: "msg_daily_launch".into(),
        tool_call_id: "call_daily_launch".into(),
        input_id: "msg_daily_child_input".into(),
        description: "Explore".into(),
        agent: "build".into(),
        model: Document::new(parse_json(r#"{"providerID":"openai","id":"gpt-runtime"}"#).unwrap())
            .unwrap(),
        prompt_digest: "d".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: "running".into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: now(),
        owner_pid: None,
        owner_started: None,
        revision: 0,
        time_created: now(),
        time_updated: now(),
        usage_anchor: None,
    }
}

fn task_row(store: &ycoding_core::ycoding_store::Client) -> Task {
    store
        .snapshot()
        .unwrap()
        .get::<TaskTable>(&tuple_key(&[KeyPart::String(&CHILD.into())]))
        .unwrap()
        .unwrap()
}

fn events(store: &ycoding_core::ycoding_store::Client, session: &str) -> Vec<(String, String)> {
    store
        .snapshot()
        .unwrap()
        .scan::<EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.aggregate_id.as_str() == Some(session))
        .map(|event| {
            (
                event.type_.as_str().unwrap_or_default().to_owned(),
                stringify_json(&event.data),
            )
        })
        .collect()
}

struct Provider {
    endpoint: String,
    bodies: Arc<Mutex<Vec<String>>>,
    stop: tokio::sync::oneshot::Sender<()>,
    server: tokio::task::JoinHandle<()>,
}

impl Provider {
    async fn start(replies: Vec<String>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let recorded = bodies.clone();
        let router = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(move |body: axum::body::Bytes| {
                let reply = {
                    let mut bodies = recorded.lock().unwrap();
                    bodies.push(stringify_json(
                        &parse_json(std::str::from_utf8(&body).unwrap()).unwrap(),
                    ));
                    replies
                        .get(bodies.len() - 1)
                        .cloned()
                        .unwrap_or_else(|| text("Done"))
                };
                async move {
                    axum::http::Response::builder()
                        .header("content-type", "text/event-stream")
                        .body(axum::body::Body::from(reply))
                        .unwrap()
                }
            }),
        );
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .unwrap();
        });
        Self {
            endpoint,
            bodies,
            stop,
            server,
        }
    }

    fn bodies(&self) -> Vec<String> {
        self.bodies.lock().unwrap().clone()
    }

    async fn stop(self) {
        self.stop.send(()).unwrap();
        self.server.await.unwrap();
    }
}

fn tool_call(call: &str, name: &str, arguments: &str) -> String {
    format!(
        "data: {{\"id\":\"tool\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"{call}\",\"type\":\"function\",\"function\":{{\"name\":\"{name}\",\"arguments\":{}}}}}]}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":2}}}}\n\ndata: [DONE]\n\n",
        stringify_json(&JsonValue::String(arguments.into()))
    )
}

fn text(content: &str) -> String {
    format!(
        "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":2}}}}\n\ndata: [DONE]\n\n",
        stringify_json(&JsonValue::String(content.into()))
    )
}

fn isolated(name: &str, phases: &[&str], body: impl FnOnce(&str, PathBuf)) {
    if let Some((root, phase)) = assigned() {
        return body(&phase, root);
    }
    let root = Disposable::new();
    for phase in phases {
        assert!(child(name, phase, &root.0).status().unwrap().success());
    }
}

fn assigned() -> Option<(PathBuf, String)> {
    let root = PathBuf::from(std::env::var_os(ROOT)?);
    let phase = std::env::var(PHASE).unwrap();
    for (key, value) in std::env::vars_os() {
        let key = key.to_str().unwrap().to_owned();
        match key.as_str() {
            "HOME" | "XDG_CONFIG_HOME" | "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME"
            | "TMPDIR" | ROOT => {
                assert!(
                    Path::new(&value).starts_with(&root),
                    "{key} escapes the disposable root"
                )
            }
            "OPENAI_API_KEY" => assert_eq!(value, SYNTHETIC_KEY),
            PHASE | "__CF_USER_TEXT_ENCODING" => {}
            _ => assert!(
                INHERITED.contains(&key.as_str()),
                "unexpected inherited variable {key}"
            ),
        }
    }
    Some((root, phase))
}

fn child(name: &str, phase: &str, root: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.env_clear();
    for key in INHERITED {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for directory in ["home", "config", "data", "state", "cache", "tmp", "project"] {
        std::fs::create_dir_all(root.join(directory)).unwrap();
    }
    command
        .current_dir(root.join("project"))
        .env("HOME", root.join("home"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("TMPDIR", root.join("tmp"))
        .env("OPENAI_API_KEY", SYNTHETIC_KEY)
        .env(ROOT, root)
        .env(PHASE, phase)
        .args([name, "--exact", "--nocapture", "--test-threads=1"]);
    command
}

fn run(
    body: impl for<'a> FnOnce(
        &'a production_owner::Host,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>>,
) {
    production_owner::run(|host| {
        let flow = body(host);
        Box::pin(async move {
            tokio::time::timeout(Duration::from_secs(60), flow)
                .await
                .unwrap();
        })
    });
}

struct Disposable(PathBuf);

impl Disposable {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "daily-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}

impl Drop for Disposable {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}
