//! SUITE-POLICY composed acceptance flows for TEST-019 to TEST-022.
//! Expected behaviour is from plans/rust-backend/test-suites.md rows
//! TEST-019..022, the root AGENTS.md autonomy rules, and live TS main.
//! The native executor in TEST-022 is a recorded test double; live native
//! evidence belongs to SUITE-NATIVE. The TEST-019 runtime/client socket leg
//! belongs to the relay/wire lanes; this target covers Core's public reply
//! and authority API with owner (root-family / Location) identity.

#![cfg(unix)]

#[path = "authority_flow_support/mod.rs"]
mod support;

use std::{
    collections::BTreeMap,
    ops::Bound,
    sync::{Arc, Mutex},
    time::Duration,
};
use support::{Fixture, rule, until};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Notify,
};
use ycoding_core::{
    platform::{
        computer::{
            self,
            boundary::{
                self as computer_boundary, Context as ComputerContext,
                Permission as ComputerPermission, PermissionFailure, Policy as ComputerPolicy,
                Reservation as ComputerReservation, Resolved, Review,
            },
            service::Coordinator as ComputerCoordinator,
            types::{Owner, Request as ComputerRequest, Success},
        },
        shell::Shell,
    },
    process::guardrails::{CustomLayer, Input as GuardrailInput},
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        config::{Configuration, LoadOptions, Roots},
        credential, decision, model,
    },
    session::{
        autonomy::{Goal, Service as AutonomyService, YoloLevel},
        orchestration::{
            Execution as OrchestrationExecution, LaunchInput, Prepared,
            Service as OrchestrationService,
        },
        pending as session_pending_mod,
        run_coordinator::{Coordinator, Outcome, RunFuture},
        runner::{Local, Services, WallClock},
        store::Service as SessionStoreService,
    },
    tools::{
        builtin::{
            decision::Decision,
            question::Question,
            shell::{AUTO_BACKGROUND, Job, Jobs, Lease, Notice, NoticeFuture, ShellTool},
        },
        code_mode::Cancellation,
        context::{Context, policy::LeafPolicy},
        policy::{
            Effect,
            forms::Forms,
            helper::{self, Models},
            permissions::SavedPermissions,
        },
        registry::{Options as RegistryOptions, Registry, Tool},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, form, guardrail, parse_json, permission,
    project_id::ProjectId, session, session_message, session_pending, stringify_json,
};
use ycoding_store::{
    Metadata, Options as StoreOptions, Store, resources::RequestTable, session::EventTable,
};

fn perm_request(
    session_id: &session::Id,
    name: &str,
    action: &str,
    resource: &str,
) -> permission::Request {
    permission::Request {
        id: permission::Id::new(name).unwrap(),
        session_id: session_id.clone(),
        action: action.into(),
        resources: vec![resource.into()],
        save: Some(vec![resource.into()]),
        metadata: None,
        source: None,
    }
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("operation exceeded 30 seconds")
}

// ---------------------------------------------------------------------------
// Real shell tool over a LeafPolicy (TEST-019 / TEST-021 effect boundary)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ShellJobs {
    notices: Mutex<Vec<Notice>>,
}
impl Jobs for ShellJobs {
    fn foreground(&self, _job: &Job, _background: Arc<Notify>) -> Lease {
        Box::new(())
    }
    fn background(&self, _job: &Job) -> Lease {
        Box::new(())
    }
    fn deliver(&self, notice: Notice) -> NoticeFuture {
        self.notices.lock().unwrap().push(notice);
        Box::pin(async { Ok(()) })
    }
}

struct ShellHarness {
    ledger: Store,
    shell: Arc<Shell>,
    tool: Arc<ShellTool>,
    leaf: Arc<LeafPolicy>,
}

impl ShellHarness {
    async fn new(fixture: &Fixture, project: &str, repo: &std::path::Path) -> Self {
        let ledger = Store::disposable(
            StoreOptions::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            Metadata::new([31; 16], 1),
        )
        .unwrap();
        let roots = Roots::development(repo).unwrap();
        let configuration = Arc::new(
            Configuration::load(LoadOptions {
                directory: repo.to_owned(),
                roots: roots.clone(),
                project: false,
                content: Some("{\"shell\":\"/bin/sh\"}".into()),
                file: None,
                env: BTreeMap::new(),
            })
            .unwrap(),
        );
        let shell = Arc::new(
            Shell::new(&roots, repo.to_owned(), project, ledger.client())
                .await
                .unwrap(),
        );
        let leaf = fixture.leaf(project, repo);
        let tool = Arc::new(ShellTool {
            shell: shell.clone(),
            configuration,
            paths: Arc::new(ycoding_core::tools::builtin::filesystem::Paths {
                directory: repo.to_owned(),
                data: repo.join("data"),
                git: Arc::new(ycoding_core::platform::git::Service::new(1024 * 1024)),
            }),
            policy: leaf.clone(),
            jobs: Arc::new(ShellJobs::default()),
            auto_background: AUTO_BACKGROUND,
        });
        Self {
            ledger,
            shell,
            tool,
            leaf,
        }
    }

    fn context(&self, session_id: &session::Id, call: &str) -> Context {
        Context::new(
            session_id.as_lossless().as_str().unwrap(),
            "build",
            "msg_tool",
            call,
        )
        .unwrap()
    }

    async fn call(
        &self,
        session_id: &session::Id,
        call: &str,
        command: String,
    ) -> Result<ycoding_ai::llm::ToolOutput, ycoding_core::tools::registry::Failure> {
        let tool = self.tool.clone();
        let context = self.context(session_id, call);
        let input = parse_json(&serde_json::json!({"command": command}).to_string()).unwrap();
        within(async move { tool.settle(input, context).await }).await
    }

    async fn finish(self) {
        self.shell.shutdown().await.unwrap();
        self.ledger.shutdown().unwrap();
    }
}

// ---------------------------------------------------------------------------
// TEST-019
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test019_permission_rules_reply_ownership_and_child_ceiling_gate_real_shell_effects() {
    let mut fixture = Fixture::new();
    let repo = fixture.temp.repo_a.clone();
    let root = fixture.session("ses_root_a", None, "prj_a", &repo, 0, None);
    let child = launch_child(
        &fixture,
        &root,
        "call_ceiling",
        vec![rule("shell", "*", "deny")],
    )
    .await;
    let autonomy = AutonomyService::new(fixture.client());
    autonomy
        .set_yolo(&child, YoloLevel::GUARDRAILS)
        .await
        .unwrap();
    autonomy
        .set_goal(&child, Goal::new("Finish safely", None, None))
        .await
        .unwrap();
    fixture.session(
        "ses_root_b",
        None,
        "prj_b",
        &fixture.temp.repo_b.clone(),
        0,
        None,
    );
    let harness = ShellHarness::new(&fixture, "prj_a", &repo).await;
    let permissions_a = harness.leaf.permissions.clone();
    let permissions_b = fixture.permissions("prj_b");

    // allow: the protected effect runs without a pending request.
    fixture.set_rules(vec![rule("*", "*", "allow")]);
    let allowed = repo.join("allowed.marker");
    harness
        .call(
            &root,
            "call_allow",
            format!("touch '{}'", allowed.display()),
        )
        .await
        .unwrap();
    assert!(allowed.exists());
    assert!(permissions_a.list().is_empty());

    // deny: blocked before the effect and before any pending request exists.
    fixture.push_rule("shell", "touch *", "deny");
    fixture.events.lock().unwrap().clear();
    let denied = repo.join("denied.marker");
    assert!(
        harness
            .call(&root, "call_deny", format!("touch '{}'", denied.display()))
            .await
            .is_err()
    );
    assert!(!denied.exists());
    assert!(permissions_a.list().is_empty());
    assert!(!fixture.events_json().contains("permission.asked"));

    // ask: a reply through another Location's service cannot settle it; the
    // owning Location's reply can, and only then does the effect run once.
    fixture.set_rules(vec![rule("shell", "*", "ask")]);
    let asked = repo.join("asked.marker");
    let tool = harness.tool.clone();
    let context = harness.context(&root, "call_ask");
    let command = format!("touch '{}'", asked.display());
    let input = parse_json(&serde_json::json!({"command": command}).to_string()).unwrap();
    let call = tokio::spawn(async move { tool.settle(input, context).await });
    let pending = until(|| permissions_a.list().into_iter().next()).await;
    assert_eq!(pending.session_id, root);
    assert!(
        permissions_b
            .reply(&pending.id, permission::Reply("once".into()), None)
            .is_err(),
        "foreign Location reply must be rejected"
    );
    assert!(!asked.exists());
    assert_eq!(
        permissions_a.list().len(),
        1,
        "non-owner reply had an effect"
    );
    permissions_a
        .reply(&pending.id, permission::Reply("once".into()), None)
        .unwrap();
    within(call).await.unwrap().unwrap();
    assert!(asked.exists());

    // ask + reject: no effect.
    let rejected = repo.join("rejected.marker");
    let tool = harness.tool.clone();
    let context = harness.context(&root, "call_reject");
    let command = format!("touch '{}'", rejected.display());
    let input = parse_json(&serde_json::json!({"command": command}).to_string()).unwrap();
    let call = tokio::spawn(async move { tool.settle(input, context).await });
    let pending = until(|| permissions_a.list().into_iter().next()).await;
    permissions_a
        .reply(&pending.id, permission::Reply("reject".into()), None)
        .unwrap();
    assert!(within(call).await.unwrap().is_err());
    assert!(!rejected.exists());

    // Saved allows and an active goal never widen the child's stored ceiling.
    let saved = SavedPermissions {
        store: fixture.client(),
    };
    saved
        .add(
            &ProjectId::new("prj_a").unwrap(),
            &"shell".into(),
            &["*".into()],
        )
        .unwrap();
    assert_eq!(
        saved
            .list(Some(&ProjectId::new("prj_a").unwrap()))
            .unwrap()
            .len(),
        1
    );
    fixture.set_rules(vec![rule("*", "*", "allow")]);
    assert_eq!(
        permissions_a
            .evaluate_effective(&child, None, &"shell".into(), &"touch x".into())
            .unwrap(),
        Effect::Deny,
        "child ceiling must survive saved allows and goals"
    );
    assert_eq!(
        permissions_a
            .evaluate_effective(&root, None, &"shell".into(), &"touch x".into())
            .unwrap(),
        Effect::Allow
    );
    let child_marker = repo.join("child.marker");
    assert!(
        harness
            .call(
                &child,
                "call_child",
                format!("touch '{}'", child_marker.display())
            )
            .await
            .is_err()
    );
    assert!(!child_marker.exists());

    harness.finish().await;
    fixture.shutdown();
}

// Scripted local provider endpoint (F-RUN: replaces only the external provider).
enum ProviderReply {
    Stream(String),
    Rejected(String),
    Held,
}

async fn provider_server(
    replies: Vec<ProviderReply>,
) -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = tokio::sync::mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for reply in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0u8; 8192];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                if read == 0 {
                    return;
                }
                raw.extend_from_slice(&buffer[..read]);
                if let Some(position) = raw.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break position + 4;
                }
            };
            let headers = std::str::from_utf8(&raw[..boundary]).unwrap().to_owned();
            let length: usize = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            while raw.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                if read == 0 {
                    return;
                }
                raw.extend_from_slice(&buffer[..read]);
            }
            let body = parse_json(std::str::from_utf8(&raw[boundary..boundary + length]).unwrap())
                .unwrap();
            send.send(body).unwrap();
            let (status, mime, reply) = match reply {
                ProviderReply::Stream(reply) => (200, "text/event-stream", reply),
                ProviderReply::Rejected(reply) => (400, "application/json", reply),
                ProviderReply::Held => {
                    let _ = stream.read(&mut buffer).await;
                    return;
                }
            };
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: {mime}\r\nX-Fixture-Private: sentinel-private-header\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                reply.len(),
                reply
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    (address, receive, task)
}

fn sse_tool(command: &str) -> String {
    let arguments = serde_json::json!({"command": command}).to_string();
    let first = serde_json::json!({"id":"tool","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_runner","type":"function","function":{"name":"shell","arguments":arguments}}]},"finish_reason":null}]});
    let second = serde_json::json!({"id":"tool","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}});
    format!("data: {first}\n\ndata: {second}\n\ndata: [DONE]\n\n")
}

fn sse_text(text: &str) -> String {
    let first = serde_json::json!({"id":"reply","choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
    let second = serde_json::json!({"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"raw_payload":"sentinel-raw-payload","account_id":"sentinel-account-id","account_email":"sentinel-email@example.test"}});
    format!("data: {first}\n\ndata: {second}\n\ndata: [DONE]\n\n")
}

fn runner_catalog(endpoint: &str) -> Catalog {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"sentinel-credential","baseURL":"{endpoint}"}}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    catalog
}

async fn admit_prompt(
    store: &SessionStoreService,
    session_id: &session::Id,
    name: &str,
    text: &str,
) {
    store
        .admit(session_pending_mod::Request {
            id: session_message::Id::new(format!("msg_{name}")).unwrap(),
            session_id: session_id.clone(),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"steer"}}"#
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new(format!("evt_{name}")).unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn test019_runner_permission_reply_gates_real_shell_effect() {
    let mut fixture = Fixture::new();
    let repo = fixture.temp.repo_a.clone();
    let root = fixture.session("ses_runner_a", None, "prj_a", &repo, 0, None);
    fixture.session(
        "ses_runner_b",
        None,
        "prj_b",
        &fixture.temp.repo_b.clone(),
        0,
        None,
    );
    fixture.set_rules(vec![rule("shell", "*", "ask")]);

    let shell_harness = ShellHarness::new(&fixture, "prj_a", &repo).await;
    let permissions_a = shell_harness.leaf.permissions.clone();
    let permissions_b = fixture.permissions("prj_b");
    let registry = Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &Roots::development(&repo).unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ));
    let _registration = registry
        .register(
            vec![("shell".into(), shell_harness.tool.clone() as Arc<dyn Tool>)],
            RegistryOptions::direct(),
        )
        .unwrap();

    let marker = repo.join("runner.marker");
    let (endpoint, mut requests, server) = provider_server(vec![
        ProviderReply::Stream(sse_tool(&format!("touch '{}'", marker.display()))),
        ProviderReply::Stream(sse_text("Done")),
    ])
    .await;
    let sessions = SessionStoreService::new(fixture.client());
    admit_prompt(&sessions, &root, "runner", "Run the shell tool").await;
    let local = Local::new(Services {
        store: sessions.clone(),
        events: ycoding_core::event_feed::Feed::attach(&fixture.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(&format!(r#"{{"directory":"{}"}}"#, repo.display())).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(runner_catalog(&endpoint))),
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(fixture.client()),
        tools: registry.clone(),
        attachments: Arc::new(
            attachment_store::Store::new(fixture.temp.root.join("attachments")).unwrap(),
        ),
        instructions: vec![],
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true),
        helpers: Default::default(),
        cursor: None,
        skill_resolver: None,
        snapshots: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        claude: None,
        auth: None,
    });
    let coordinator = Coordinator::new(Arc::new(local));
    let runner = {
        let coordinator = coordinator.clone();
        let root = root.clone();
        tokio::spawn(async move { coordinator.run(&root).await })
    };
    let pending = until(|| permissions_a.list().into_iter().next()).await;
    assert_eq!(pending.session_id, root);
    assert!(
        permissions_b
            .reply(&pending.id, permission::Reply("once".into()), None)
            .is_err()
    );
    assert!(
        !marker.exists(),
        "foreign reply must not release the effect"
    );
    assert_eq!(permissions_a.list().len(), 1);
    permissions_a
        .reply(&pending.id, permission::Reply("once".into()), None)
        .unwrap();
    within(runner).await.unwrap().unwrap();
    assert!(
        marker.exists(),
        "owner reply must release exactly the gated effect"
    );
    requests.recv().await.unwrap();
    requests.recv().await.unwrap();
    server.await.unwrap();
    let history = sessions.context(&root).unwrap();
    assert!(
        history
            .iter()
            .any(|message| stringify_json(&message.encode()).contains("Command exited")),
        "consumer history must show the settled tool result"
    );

    // Deny in the runner: the tool is refused and no second effect occurs.
    fixture.push_rule("shell", "*", "deny");
    let denied = repo.join("runner-denied.marker");
    let (endpoint, mut requests, server) = provider_server(vec![
        ProviderReply::Stream(sse_tool(&format!("touch '{}'", denied.display()))),
        ProviderReply::Stream(sse_text("Done")),
    ])
    .await;
    let sessions = SessionStoreService::new(fixture.client());
    admit_prompt(&sessions, &root, "runner2", "Run it again").await;
    // Rebuild the Location runner against the second scripted endpoint.
    let local = Local::new(Services {
        store: sessions.clone(),
        events: ycoding_core::event_feed::Feed::attach(&fixture.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(&format!(r#"{{"directory":"{}"}}"#, repo.display())).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(runner_catalog(&endpoint))),
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(fixture.client()),
        tools: registry.clone(),
        attachments: Arc::new(
            attachment_store::Store::new(fixture.temp.root.join("attachments")).unwrap(),
        ),
        instructions: vec![],
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true),
        helpers: Default::default(),
        cursor: None,
        skill_resolver: None,
        snapshots: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        claude: None,
        auth: None,
    });
    let coordinator2 = Coordinator::new(Arc::new(local));
    within(coordinator2.run(&root)).await.unwrap();
    assert!(!denied.exists());
    requests.recv().await.unwrap();
    requests.recv().await.unwrap();
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    coordinator2.shutdown().await.unwrap();

    shell_harness.finish().await;
    fixture.shutdown();
}

// ---------------------------------------------------------------------------
// TEST-020
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Recorder {
    woken: Mutex<Vec<String>>,
    resumed: Mutex<Vec<String>>,
}
impl OrchestrationExecution for Recorder {
    fn wake(&self, id: &session::Id) -> Outcome {
        self.woken
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Ok(())
    }
    fn resume(&self, id: &session::Id) -> RunFuture {
        self.resumed
            .lock()
            .unwrap()
            .push(id.as_lossless().as_str().unwrap().into());
        Box::pin(async { Ok(()) })
    }
    fn interrupt(&self, id: &session::Id) -> RunFuture {
        let id = id.clone();
        Box::pin(async move {
            let _ = id;
            Ok(())
        })
    }
}

async fn launch_child(
    fixture: &Fixture,
    root: &session::Id,
    call_id: &str,
    caller_permissions: permission::Ruleset,
) -> session::Id {
    let sessions = SessionStoreService::new(fixture.client());
    let service = OrchestrationService::new(sessions, Arc::new(Recorder::default()));
    let guardrails = fixture.guardrails("prj_a", &fixture.temp.repo_a, Arc::new(Vec::new), true);
    service
        .launch(LaunchInput {
            parent_id: root.clone(),
            parent_assistant_message_id: session_message::Id::new("msg_parent").unwrap(),
            tool_call_id: call_id.into(),
            description: "Explore".into(),
            prompt: "Look around".into(),
            depth_limit: 1,
            prepared: Prepared {
                agent: "explore".into(),
                caller_permissions,
                model: ycoding_schema::model::Ref::decode(
                    &parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
                )
                .unwrap(),
                profile_binding: None,
            },
            guardrails,
        })
        .await
        .unwrap()
        .session_id
}

fn guardrail_input(session_id: &session::Id, resource: String) -> GuardrailInput {
    GuardrailInput {
        session_id: session_id.clone(),
        action: "shell".into(),
        resources: vec![resource.into()],
        metadata: None,
        skip_review: false,
        holder: None,
        defer_shell: false,
        source: None,
    }
}

#[tokio::test]
async fn test019_root_child_family_and_location_review_reply_matrix_gates_shell_effects() {
    let fixture = Fixture::new();
    let repo = &fixture.temp.repo_a;
    let root = fixture.session("ses_root_a", None, "prj_a", repo, 0, None);
    let child = fixture.session("ses_child_a", Some("ses_root_a"), "prj_a", repo, 0, None);
    let other = fixture.session("ses_other_a", None, "prj_a", repo, 0, None);
    let foreign = fixture.session("ses_root_b", None, "prj_b", &fixture.temp.repo_b, 0, None);
    let harness = ShellHarness::new(&fixture, "prj_a", repo).await;
    let guardrails = harness.leaf.guardrails.clone();
    let foreign_guardrails =
        fixture.guardrails("prj_b", &fixture.temp.repo_b, Arc::new(Vec::new), true);
    fixture.set_rules(vec![rule("shell", "*", "allow")]);
    for (index, (requestor, owner)) in [
        (&root, &root),
        (&root, &child),
        (&child, &root),
        (&child, &child),
    ]
    .into_iter()
    .enumerate()
    {
        let marker = fixture.temp.outside.join(format!("ownership-{index}"));
        let input = parse_json(
            &serde_json::json!({"command":format!("printf 'effect\\n' >> '{}'", marker.display())})
                .to_string(),
        )
        .unwrap();
        let tool = harness.tool.clone();
        let context = harness.context(requestor, &format!("call_matrix_{index}"));
        let mut task = tokio::spawn(async move { tool.settle(input, context).await });
        let request = tokio::select! {
            request = until(|| guardrails.for_session(requestor).unwrap().into_iter().next()) => request,
            result = &mut task => panic!("shell settled before review: {result:?}"),
        };
        for non_owner in [&other, &foreign] {
            let before = fixture.events.lock().unwrap().clone();
            assert!(
                guardrails
                    .reply(non_owner, &request.id, guardrail::Reply::Once)
                    .is_err()
            );
            assert_eq!(*fixture.events.lock().unwrap(), before);
            assert_eq!(
                guardrails.for_session(requestor).unwrap(),
                vec![request.clone()]
            );
            assert!(!marker.exists());
            assert!(!task.is_finished());
        }
        assert!(
            foreign_guardrails
                .reply(&foreign, &request.id, guardrail::Reply::Once)
                .is_err()
        );
        assert!(!marker.exists());
        guardrails
            .reply(owner, &request.id, guardrail::Reply::Once)
            .unwrap();
        within(task).await.unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "effect\n");
        assert!(guardrails.for_session(requestor).unwrap().is_empty());
    }
    harness.finish().await;
}

async fn safe_effect(
    admission: ycoding_core::process::guardrails::Admission,
    marker: &std::path::Path,
) -> bool {
    let reservation = match admission.wait {
        Some(wait) => match within(wait).await.unwrap() {
            Ok(reservation) => reservation,
            Err(_) => return false,
        },
        None => admission.reservation.expect("admitted reservation"),
    };
    let status = tokio::process::Command::new("/bin/sh")
        .args(["-c", "printf 'effect\\n' >> \"$1\"", "safe-authority-probe"])
        .arg(marker)
        .status()
        .await
        .unwrap();
    assert!(status.success());
    reservation.release();
    true
}

#[tokio::test]
async fn test020_yolo_goal_matrix_settles_every_authority_kind() {
    for level in 0..=2u8 {
        for goal in [false, true] {
            for toggle in [false, true] {
                let mut fixture = Fixture::new();
                let repo = fixture.temp.repo_a.clone();
                let root = fixture.session("ses_root_a", None, "prj_a", &repo, 0, None);
                let autonomy = AutonomyService::new(fixture.client());
                autonomy
                    .set_yolo(&root, YoloLevel::new(level).unwrap())
                    .await
                    .unwrap();
                if goal {
                    autonomy
                        .set_goal(&root, Goal::new("Finish safely", None, None))
                        .await
                        .unwrap();
                }
                autonomy.set_auto_answer(&root, toggle).await.unwrap();
                let auto_permission = level >= 1;
                let auto_guardrail = level >= 2;
                let auto_answer = toggle;
                let label = format!("yolo={level} goal={goal} auto_answer={toggle}");

                // Permission ask.
                fixture.set_rules(vec![rule("shell", "*", "ask")]);
                let permissions = fixture.permissions("prj_a");
                let admission = permissions
                    .ask(
                        perm_request(&root, &format!("per_m{level}_{goal}"), "shell", "touch x"),
                        None,
                    )
                    .unwrap();
                if auto_permission {
                    assert_eq!(admission.effect, Effect::Allow, "permission {label}");
                    assert!(permissions.list().is_empty(), "permission {label}");
                } else {
                    assert_eq!(admission.effect, Effect::Ask, "permission {label}");
                    assert_eq!(
                        permissions.list().len(),
                        1,
                        "permission {label}: human wait"
                    );
                    permissions
                        .reply(&admission.id, permission::Reply("once".into()), None)
                        .unwrap();
                    admission.wait.unwrap().await.unwrap().unwrap();
                    assert!(
                        fixture.events_json().contains("permission.replied"),
                        "permission settlement {label}"
                    );
                }

                // Ordinary guardrail review (outside-repository write).
                let guardrails = fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true);
                let outside = format!("touch '{}/file'", fixture.temp.outside.display());
                let admission = guardrails.assert(guardrail_input(&root, outside)).unwrap();
                if auto_guardrail {
                    assert_eq!(admission.effect, Effect::Allow, "guardrail {label}");
                    admission.reservation.unwrap().release();
                } else {
                    assert_eq!(admission.effect, Effect::Ask, "guardrail {label}");
                    let request = admission.request.clone().unwrap();
                    assert_eq!(request.hard_review, None, "guardrail {label}");
                    assert_eq!(
                        guardrails.for_session(&root).unwrap(),
                        vec![request.clone()]
                    );
                    guardrails
                        .reply(&root, &request.id, guardrail::Reply::Once)
                        .unwrap();
                    admission.wait.unwrap().await.unwrap().unwrap().release();
                    assert!(
                        fixture.events_json().contains("guardrail.replied"),
                        "review settlement {label}"
                    );
                }

                // Form.
                let forms = Forms::new(fixture.authority(), fixture.publisher());
                let form_info = form::Info::decode(
                &parse_json(&format!(
                    r#"{{"id":"frm_m{level}_{goal}","sessionID":"{}","title":"Choose","fields":[{{"key":"flag","type":"boolean"}}]}}"#,
                    root.as_lossless().as_str().unwrap()
                ))
                .unwrap(),
            )
            .unwrap();
                let wait = forms.ask(form_info.clone()).unwrap();
                if auto_answer {
                    let state = within(wait).await.unwrap();
                    assert!(matches!(state, form::State::Answered(_)), "form {label}");
                } else {
                    assert_eq!(
                        forms.state(&form_info.id).unwrap(),
                        form::State::Pending,
                        "form {label}"
                    );
                    forms
                        .reply(
                            &form_info.id,
                            form::Answer::decode(&parse_json(r#"{"flag":true}"#).unwrap()).unwrap(),
                        )
                        .unwrap();
                    let state = within(wait).await.unwrap();
                    assert!(matches!(state, form::State::Answered(_)), "form {label}");
                }

                let question = Arc::new(Question {
                    forms: forms.clone(),
                    policy: fixture.leaf("prj_a", &repo),
                });
                fixture.push_rule("question", "*", "allow");
                let context = Context::new(
                    root.as_lossless().as_str().unwrap(),
                    "build",
                    "msg_question",
                    "call_question",
                )
                .unwrap();
                let task = tokio::spawn(async move {
                    question.settle(parse_json(r#"{"questions":[{"question":"Which route?","header":"Route","options":[{"label":"safe","description":"Safe choice"}]}]}"#).unwrap(), context).await
                });
                if !auto_answer {
                    let pending = until(|| forms.list(None).into_iter().next()).await;
                    assert!(
                        !task.is_finished(),
                        "question {label} must wait for a human"
                    );
                    forms
                        .reply(
                            &pending.id,
                            form::Answer::decode(&parse_json(r#"{"q0":"safe"}"#).unwrap()).unwrap(),
                        )
                        .unwrap();
                }
                let answer = within(task).await.unwrap().unwrap();
                assert!(
                    stringify_json(&answer.structured).contains("safe"),
                    "question consumer {label}"
                );

                // Child question.
                let child = launch_child(&fixture, &root, "call_child", vec![]).await;
                let sessions = SessionStoreService::new(fixture.client());
                let orchestration =
                    OrchestrationService::new(sessions, Arc::new(Recorder::default()));
                let asked = orchestration
                    .question_attributed(
                        &child,
                        "Which option?",
                        None,
                        &ycoding_core::session::usage_attribution::Attribution::Unset,
                    )
                    .await
                    .unwrap();
                assert!(
                    !asked.auto_answered,
                    "child question {label}: the root toggle is not inherited"
                );
                assert_eq!(
                    orchestration.get(&root, &child).unwrap().state,
                    ycoding_schema::session_orchestration::State::Waiting,
                    "child question {label}"
                );
                let answered = orchestration
                    .answer(
                        &root,
                        &child,
                        &asked.question.id,
                        Some("human choice"),
                        None,
                    )
                    .await
                    .unwrap();
                assert_eq!(
                    answered.state,
                    ycoding_schema::session_orchestration::State::Running
                );

                // Deny rules remain enforced at every level.
                fixture.push_rule("shell", "*", "deny");
                let denied = permissions
                    .ask(
                        perm_request(&root, &format!("per_d{level}_{goal}"), "shell", "touch x"),
                        None,
                    )
                    .unwrap();
                assert_eq!(denied.effect, Effect::Deny, "deny {label}");
                let child_deny = launch_child(
                    &fixture,
                    &root,
                    "call_ceiling",
                    vec![rule("decision", "*", "deny")],
                )
                .await;
                let denied = permissions
                    .ask(
                        perm_request(
                            &child_deny,
                            &format!("per_c{level}_{goal}"),
                            "decision",
                            "agent",
                        ),
                        None,
                    )
                    .unwrap();
                assert_eq!(denied.effect, Effect::Deny, "inherited ceiling {label}");
                drop(permissions);
                drop(guardrails);
                drop(forms);
                fixture.shutdown();
            }
        }
    }
}

#[tokio::test]
async fn test020_file_backed_restart_preserves_numeric_level_and_durable_child_wait() {
    let mut fixture = Fixture::new();
    let repo = fixture.temp.repo_a.clone();
    let root = fixture.session("ses_root_a", None, "prj_a", &repo, 0, None);
    fixture.set_rules(vec![rule("shell", "*", "ask")]);
    let levels = (0..=2)
        .map(|level| {
            fixture.session(
                &format!("ses_level_{level}"),
                None,
                "prj_a",
                &repo,
                level,
                None,
            )
        })
        .collect::<Vec<_>>();
    let child = launch_child(&fixture, &root, "call_child", vec![]).await;

    let question_id = {
        let permissions = fixture.permissions("prj_a");
        let admission = permissions
            .ask(perm_request(&root, "per_restart", "shell", "touch x"), None)
            .unwrap();
        assert_eq!(admission.effect, Effect::Ask);
        let permission_wait = admission.wait.unwrap();

        let guardrails = fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true);
        let outside = format!("touch '{}/file'", fixture.temp.outside.display());
        let admission = guardrails.assert(guardrail_input(&root, outside)).unwrap();
        assert_eq!(admission.effect, Effect::Ask);
        let guardrail_wait = admission.wait.unwrap();

        let forms = Forms::new(fixture.authority(), fixture.publisher());
        let form_info = form::Info::decode(
            &parse_json(&format!(
                r#"{{"id":"frm_restart","sessionID":"{}","title":"Choose","fields":[{{"key":"flag","type":"boolean"}}]}}"#,
                root.as_lossless().as_str().unwrap()
            ))
            .unwrap(),
        )
        .unwrap();
        let wait = forms.ask(form_info.clone()).unwrap();

        let sessions = SessionStoreService::new(fixture.client());
        let orchestration = OrchestrationService::new(sessions, Arc::new(Recorder::default()));
        let asked = orchestration
            .question(&child, "Which option?", None)
            .await
            .unwrap();
        assert!(!asked.auto_answered);

        let autonomy = AutonomyService::new(fixture.client());
        autonomy
            .set_yolo(&root, YoloLevel::GUARDRAILS)
            .await
            .unwrap();
        assert_eq!(permissions.list().len(), 1);
        assert_eq!(guardrails.for_session(&root).unwrap().len(), 1);
        assert_eq!(forms.list(None).len(), 1);
        permissions.shutdown();
        guardrails.shutdown();
        assert!(forms.shutdown().is_empty());
        assert!(permission_wait.await.unwrap().is_err());
        assert!(guardrail_wait.await.unwrap().is_err());
        assert_eq!(wait.await.unwrap(), form::State::Cancelled);
        asked.question.id.clone()
    };

    fixture.restart();

    let autonomy = AutonomyService::new(fixture.client());
    for (level, session) in levels.iter().enumerate() {
        assert_eq!(autonomy.effective(session).unwrap().yolo.get(), level as u8);
    }
    let effective = autonomy.effective(&root).unwrap();
    assert_eq!(
        effective.yolo.get(),
        2,
        "stored numeric YOLO level must survive restart as 2"
    );

    let sessions = SessionStoreService::new(fixture.client());
    let orchestration = OrchestrationService::new(sessions, Arc::new(Recorder::default()));
    let task = orchestration.get(&root, &child).unwrap();
    assert_eq!(
        task.state,
        ycoding_schema::session_orchestration::State::Waiting
    );
    assert_eq!(task.question.unwrap().id, question_id);
    let answered = orchestration
        .answer(
            &root,
            &child,
            &question_id,
            Some("human after restart"),
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        answered.state,
        ycoding_schema::session_orchestration::State::Running
    );

    let permissions = fixture.permissions("prj_a");
    assert!(
        permissions.list().is_empty(),
        "TS parity: permission waits are Location-owned, not durable"
    );
    let guardrails = fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true);
    assert!(
        guardrails.for_session(&root).unwrap().is_empty(),
        "TS parity: reviews are Location-owned, not durable"
    );
    let forms = Forms::new(fixture.authority(), fixture.publisher());
    assert!(
        forms.list(None).is_empty(),
        "TS parity: Forms are Location-owned, not durable"
    );
    fixture.shutdown();
}

// ---------------------------------------------------------------------------
// TEST-021
// ---------------------------------------------------------------------------

fn custom_allow_layer() -> Vec<CustomLayer> {
    vec![CustomLayer {
        rules: vec![guardrail::Rule {
            id: "custom-allow".into(),
            source: guardrail::RuleSource::Custom,
            decision: guardrail::RuleDecision::Allow,
            actions: vec!["*".into()],
            resources: vec!["*".into()],
            reason: "allow everything".into(),
            priority: ycoding_schema::schema::Int::new(0).unwrap(),
        }],
        invalid_files: vec![],
    }]
}

#[tokio::test]
async fn test021_hard_reviews_require_fresh_human_once_or_reject_for_every_class() {
    let classes: [(&str, &str); 6] = [
        ("git reset --hard", "standard.review.git-destructive"),
        ("git push origin main --force", "standard.review.force-push"),
        ("drop table users", "standard.review.database-destructive"),
        ("rm -rf .", "standard.review.project-deletion"),
        ("rm -rf ..", "standard.review.project-deletion"),
        ("rm -rf ~/notes", "standard.review.home-child"),
    ];
    // (yolo, goal, custom allow, external-directory exemption, reviews enabled)
    let contexts: [(u8, bool, bool, bool, bool); 9] = [
        (0, false, false, false, true),
        (1, false, false, false, true),
        (2, false, false, false, true),
        (0, true, false, false, true),
        (1, true, false, false, true),
        (2, true, false, false, true),
        (0, false, true, false, true),
        (2, true, false, true, true),
        (2, true, true, true, false),
    ];
    for (command, rule_id) in classes {
        let mut fixture = Fixture::new();
        let repo = fixture.temp.repo_a.clone();
        let root = fixture.session("ses_root_a", None, "prj_a", &repo, 0, None);
        let other_family = fixture.session("ses_other_a", None, "prj_a", &repo, 0, None);
        let root_b = fixture.session(
            "ses_root_b",
            None,
            "prj_b",
            &fixture.temp.repo_b.clone(),
            0,
            None,
        );
        let autonomy = AutonomyService::new(fixture.client());
        let mut effects = 0u32;
        let marker = fixture.temp.outside.join("hard-effect.marker");

        for (level, goal, custom, exempt, enabled) in contexts {
            autonomy
                .set_yolo(&root, YoloLevel::new(level).unwrap())
                .await
                .unwrap();
            if goal {
                autonomy
                    .set_goal(&root, Goal::new("Finish safely", None, None))
                    .await
                    .unwrap();
            } else {
                let _ = autonomy.stop(&root).await;
            }
            if exempt {
                fixture.push_rule("external_directory", "*", "allow");
            }
            let custom_layers: ycoding_core::process::guardrails::CustomLayers = if custom {
                Arc::new(custom_allow_layer)
            } else {
                Arc::new(Vec::new)
            };
            let guardrails = fixture.guardrails("prj_a", &repo, custom_layers, enabled);
            let admission = guardrails
                .assert(guardrail_input(&root, command.into()))
                .unwrap();
            assert_eq!(
                admission.effect,
                Effect::Ask,
                "{command} yolo={level} goal={goal} custom={custom} exempt={exempt} enabled={enabled}"
            );
            let request = admission.request.clone().unwrap();
            assert_eq!(
                request.hard_review,
                Some(true),
                "{command} must stay a hard review"
            );
            assert!(
                request
                    .rule_ids
                    .iter()
                    .any(|id| id.as_str() == Some(rule_id)),
                "{command} must classify as {rule_id}: {:?}",
                request.rule_ids
            );
            let before = effects;
            guardrails
                .reply(&root, &request.id, guardrail::Reply::Always)
                .unwrap();
            assert!(
                !safe_effect(admission, &marker).await,
                "{command}: always must not approve"
            );
            for reply in [guardrail::Reply::Reject, guardrail::Reply::Once] {
                let admission = guardrails
                    .assert(guardrail_input(&root, command.into()))
                    .unwrap();
                assert_eq!(
                    admission.effect,
                    Effect::Ask,
                    "fresh human review: {command}"
                );
                let request = admission.request.as_ref().unwrap();
                guardrails.reply(&root, &request.id, reply).unwrap();
                let ran = safe_effect(admission, &marker).await;
                assert_eq!(ran, reply == guardrail::Reply::Once, "{command} {reply:?}");
                if ran {
                    effects += 1;
                }
                let actual =
                    std::fs::read_to_string(&marker).map_or(0, |value| value.lines().count());
                assert_eq!(
                    actual, effects as usize,
                    "{command}: exact safe process effect"
                );
            }
            assert_eq!(
                effects,
                before + 1,
                "{command}: one fresh approval, one safe effect"
            );
            if exempt {
                fixture
                    .rules
                    .lock()
                    .unwrap()
                    .retain(|item| item.action.as_str() != Some("external_directory"));
            }
            drop(guardrails);
        }

        // Reject: zero effect. Once: exactly one gated effect, then it asks again.
        autonomy.set_yolo(&root, YoloLevel::OFF).await.unwrap();
        let _ = autonomy.stop(&root).await;
        let guardrails = fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true);
        for reply in [guardrail::Reply::Reject, guardrail::Reply::Once] {
            let admission = guardrails
                .assert(guardrail_input(&root, command.into()))
                .unwrap();
            let request = admission.request.clone().unwrap();
            guardrails.reply(&root, &request.id, reply).unwrap();
            let ran = safe_effect(admission, &marker).await;
            assert_eq!(ran, reply == guardrail::Reply::Once);
            if ran {
                effects += 1;
            }
        }
        assert_eq!(
            effects,
            contexts.len() as u32 + 1,
            "{command}: once must produce exactly one effect"
        );
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap().lines().count(),
            effects as usize
        );

        // A settled approval never carries to another family or Location.
        let admission = guardrails
            .assert(guardrail_input(&root, command.into()))
            .unwrap();
        assert_eq!(
            admission.effect,
            Effect::Ask,
            "{command}: approval must not be reused"
        );
        let request = admission.request.clone().unwrap();
        guardrails
            .reply(&root, &request.id, guardrail::Reply::Reject)
            .unwrap();
        assert!(admission.wait.unwrap().await.unwrap().is_err());

        let foreign = guardrails
            .assert(guardrail_input(&other_family, command.into()))
            .unwrap();
        assert_eq!(foreign.effect, Effect::Ask, "{command}: other family");
        let request = foreign.request.clone().unwrap();
        assert!(
            guardrails
                .reply(&root, &request.id, guardrail::Reply::Once)
                .is_err(),
            "cross-family reply rejected"
        );
        guardrails
            .reply(&other_family, &request.id, guardrail::Reply::Reject)
            .unwrap();
        assert!(foreign.wait.unwrap().await.unwrap().is_err());

        let guardrails_b = fixture.guardrails(
            "prj_b",
            &fixture.temp.repo_b.clone(),
            Arc::new(Vec::new),
            true,
        );
        let foreign = guardrails_b
            .assert(guardrail_input(&root_b, command.into()))
            .unwrap();
        assert_eq!(foreign.effect, Effect::Ask, "{command}: other Location");
        let request = foreign.request.clone().unwrap();
        assert!(
            guardrails
                .reply(&root, &request.id, guardrail::Reply::Once)
                .is_err()
        );
        guardrails_b
            .reply(&root_b, &request.id, guardrail::Reply::Reject)
            .unwrap();
        assert!(foreign.wait.unwrap().await.unwrap().is_err());
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap().lines().count(),
            effects as usize
        );
        fixture.shutdown();
    }
}

#[tokio::test]
async fn test021_ordinary_always_is_scoped_to_the_root_family_and_location() {
    let mut fixture = Fixture::new();
    let repo = fixture.temp.repo_a.clone();
    let root = fixture.session("ses_root_a", None, "prj_a", &repo, 0, None);
    let child = fixture.session("ses_child_a", Some("ses_root_a"), "prj_a", &repo, 0, None);
    let other = fixture.session("ses_other_a", None, "prj_a", &repo, 0, None);
    let root_b = fixture.session(
        "ses_root_b",
        None,
        "prj_b",
        &fixture.temp.repo_b.clone(),
        0,
        None,
    );
    let guardrails = fixture.guardrails("prj_a", &repo, Arc::new(Vec::new), true);
    let outside = format!("touch '{}/file'", fixture.temp.outside.display());
    let admission = guardrails
        .assert(guardrail_input(&root, outside.clone()))
        .unwrap();
    let request = admission.request.clone().unwrap();
    assert_eq!(request.hard_review, None);
    assert!(
        guardrails
            .reply(&other, &request.id, guardrail::Reply::Always)
            .is_err()
    );
    guardrails
        .reply(&child, &request.id, guardrail::Reply::Always)
        .unwrap();
    admission.wait.unwrap().await.unwrap().unwrap().release();
    for session in [&root, &child] {
        let admitted = guardrails
            .assert(guardrail_input(session, outside.clone()))
            .unwrap();
        assert_eq!(
            admitted.effect,
            Effect::Allow,
            "always covers the root family"
        );
        admitted.reservation.unwrap().release();
    }
    let foreign = guardrails
        .assert(guardrail_input(&other, outside.clone()))
        .unwrap();
    assert_eq!(
        foreign.effect,
        Effect::Ask,
        "always must not cover another family"
    );
    let request = foreign.request.clone().unwrap();
    guardrails
        .reply(&other, &request.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(foreign.wait.unwrap().await.unwrap().is_err());

    let guardrails_b = fixture.guardrails(
        "prj_b",
        &fixture.temp.repo_b.clone(),
        Arc::new(Vec::new),
        true,
    );
    let foreign = guardrails_b
        .assert(guardrail_input(&root_b, outside))
        .unwrap();
    assert_eq!(
        foreign.effect,
        Effect::Ask,
        "always must not cover another Location"
    );
    let request = foreign.request.clone().unwrap();
    guardrails_b
        .reply(&root_b, &request.id, guardrail::Reply::Reject)
        .unwrap();
    assert!(foreign.wait.unwrap().await.unwrap().is_err());
    fixture.shutdown();
}

struct NativePolicy {
    leaf: Arc<LeafPolicy>,
    calls: Arc<Mutex<Vec<String>>>,
}

fn native_context(context: &ComputerContext) -> Context {
    Context::new(
        &context.owner.session_id,
        &context.agent,
        &context.message_id,
        &context.owner.call_id,
    )
    .unwrap()
}

struct NativeLease {
    reservation: ycoding_core::process::guardrails::Reservation,
    calls: Arc<Mutex<Vec<String>>>,
}

impl ComputerReservation for NativeLease {
    fn release(&self) {
        self.reservation.release();
        self.calls.lock().unwrap().push("release".into());
    }
}

impl ComputerPolicy for NativePolicy {
    fn permission<'a>(
        &'a self,
        context: &'a ComputerContext,
        request: ComputerPermission,
    ) -> computer::Future<'a, Result<(), PermissionFailure>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push(format!("permission:{}", request.action));
            self.leaf
                .assert_with(
                    &native_context(context),
                    &request.action,
                    request.resources.into_iter().map(Into::into).collect(),
                    request.save.into_iter().map(Into::into).collect(),
                    Some(
                        ycoding_schema::JsonObject::decode(
                            &parse_json(&request.metadata.to_string()).unwrap(),
                        )
                        .unwrap(),
                    ),
                )
                .await
                .map_err(|error| PermissionFailure::Fault(format!("{error:?}")))?
                .map_err(|error| PermissionFailure::Blocked(format!("{error:?}")))
        })
    }
    fn review<'a>(
        &'a self,
        context: &'a ComputerContext,
        request: Review,
    ) -> computer::Future<'a, Result<Box<dyn ComputerReservation>, String>> {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push(format!("review:{}:{}", request.action, request.skip_review));
            let input = GuardrailInput {
                session_id: native_context(context).session_id,
                action: request.action.clone(),
                resources: request
                    .resources
                    .iter()
                    .map(|value| value.as_str().into())
                    .collect(),
                metadata: Some(
                    ycoding_schema::JsonObject::decode(
                        &parse_json(&request.metadata.to_string()).unwrap(),
                    )
                    .unwrap(),
                ),
                skip_review: false,
                holder: None,
                defer_shell: false,
                source: None,
            };
            let evaluated = self.leaf.guardrails.evaluate(&input).unwrap();
            self.calls.lock().unwrap().push(format!(
                "classified:{:?}:{}",
                evaluated.effect, evaluated.hard_review
            ));
            let reservation = self
                .leaf
                .reserve_with(
                    &native_context(context),
                    &request.action,
                    request.resources.into_iter().map(Into::into).collect(),
                    input.metadata,
                    request.skip_review,
                )
                .await
                .map_err(|error| format!("{error:?}"))?;
            Ok(Box::new(NativeLease {
                reservation,
                calls: self.calls.clone(),
            }) as Box<dyn ComputerReservation>)
        })
    }
    fn resolve<'a>(
        &'a self,
        _path: &'a str,
        _directory: bool,
    ) -> computer::Future<'a, Result<Resolved, String>> {
        Box::pin(async {
            Err("Path resolution is outside these recorded native operations".into())
        })
    }
}

struct RecordedComputer(Arc<Mutex<Vec<String>>>);
impl computer::service::Invoke for RecordedComputer {
    fn invoke<'a>(
        &'a self,
        request: ComputerRequest,
        _signal: tokio::sync::watch::Receiver<bool>,
    ) -> computer::Future<'a, Result<Success, computer::types::NativeError>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .push(format!("native:{}", request.operation.as_str()));
            Ok(Success {
                action: request.operation,
                revision: "rev_fixture".into(),
                detail: serde_json::json!({"effect":"unchanged","tabIndex":1}),
            })
        })
    }
}

struct RecordedBrowser {
    calls: Arc<Mutex<Vec<String>>>,
    tab: ycoding_schema::browser::Tab,
}
impl ycoding_core::platform::browser::boundary::Paired for RecordedBrowser {
    fn bridge(&self) -> Result<Arc<ycoding_core::platform::browser::bridge::Bridge>, String> {
        Err("Recorded native executor has no live Chrome bridge".into())
    }
    fn list(&self, _session: &session::Id) -> Result<Vec<ycoding_schema::browser::Tab>, String> {
        Ok(vec![self.tab.clone()])
    }
    fn action<'a>(
        &'a self,
        input: ycoding_schema::browser::ActionInput,
    ) -> computer::Future<'a, Result<ycoding_schema::browser::ActionResult, String>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push("native:browser".into());
            Ok(ycoding_schema::browser::ActionResult {
                call_id: input.call_id,
                tab: self.tab.clone(),
                status: ycoding_schema::browser::ResultStatus::Completed,
                message: None,
                capture: None,
                group_id: None,
            })
        })
    }
}

#[tokio::test]
async fn test022_native_skip_review_admits_ordinary_and_hard_reviews_but_never_denies() {
    for decision in [
        guardrail::RuleDecision::Ask,
        guardrail::RuleDecision::HardReview,
        guardrail::RuleDecision::Deny,
    ] {
        for permission_deny in [false, true] {
            let fixture = Fixture::new();
            let root = fixture.session("ses_native", None, "prj_a", &fixture.temp.repo_a, 0, None);
            fixture.set_rules(vec![rule(
                "*",
                "*",
                if permission_deny { "deny" } else { "allow" },
            )]);
            let mut layer = custom_allow_layer();
            layer[0].rules[0].decision = decision;
            let leaf = Arc::new(LeafPolicy {
                permissions: fixture.permissions("prj_a"),
                guardrails: fixture.guardrails(
                    "prj_a",
                    &fixture.temp.repo_a,
                    Arc::new(move || layer.clone()),
                    true,
                ),
            });
            let calls = Arc::new(Mutex::new(Vec::new()));
            let policy = NativePolicy {
                leaf: leaf.clone(),
                calls: calls.clone(),
            };
            let context = ComputerContext {
                owner: Owner {
                    session_id: root.as_lossless().as_str().unwrap().into(),
                    call_id: "call_native".into(),
                },
                message_id: "msg_native".into(),
                agent: "build".into(),
            };
            let coordinator =
                ComputerCoordinator::new(Arc::new(RecordedComputer(calls.clone())), "darwin");
            let service = coordinator.service();
            let admitted = !permission_deny && decision != guardrail::RuleDecision::Deny;
            for input in [
                serde_json::json!({"action":"webbrowser.tabs","platform":"macos","bundle_id":"com.apple.Safari"}),
                serde_json::json!({"action":"desktop.inspect","platform":"macos","bundle_id":"test.authority","pid":1,"window_id":1}),
            ] {
                calls.lock().unwrap().clear();
                let result = within(computer_boundary::execute(
                    &service,
                    &policy,
                    &context,
                    computer_boundary::decode_input(&input).unwrap(),
                ))
                .await;
                assert_eq!(
                    result.is_ok(),
                    admitted,
                    "computer {decision:?} deny={permission_deny}"
                );
                assert_native_admission(&calls, admitted, permission_deny, decision);
            }
            coordinator.shutdown().await.unwrap();

            calls.lock().unwrap().clear();
            let browser = RecordedBrowser {
                calls: calls.clone(),
                tab: ycoding_schema::browser::Tab::decode(&parse_json(r#"{"id":"btab_fixture","sessionID":"ses_native","title":"Fixture","page":{"origin":"https://example.test","path":"/"},"status":"shared","generation":1,"documentGeneration":1,"observationRevision":1,"mode":"profile","lease":"self"}"#).unwrap()).unwrap(),
            };
            let input = ycoding_core::platform::browser::boundary::decode_input(&parse_json(r#"{"mode":"profile","operation":"action","tabID":"btab_fixture","generation":1,"documentGeneration":1,"observationRevision":1,"action":{"type":"navigate","url":"https://example.test/"}}"#).unwrap()).unwrap();
            let result = within(ycoding_core::platform::browser::boundary::execute(
                ycoding_core::platform::browser::boundary::Services {
                    paired: &browser,
                    isolated: None,
                },
                &policy,
                &context,
                input,
            ))
            .await;
            assert_eq!(
                result.is_ok(),
                admitted,
                "browser {decision:?} deny={permission_deny}: {result:?}"
            );
            assert_native_admission(&calls, admitted, permission_deny, decision);
            assert!(leaf.permissions.list().is_empty());
            assert!(leaf.guardrails.for_session(&root).unwrap().is_empty());
        }
    }
}

fn assert_native_admission(
    calls: &Mutex<Vec<String>>,
    admitted: bool,
    permission_deny: bool,
    decision: guardrail::RuleDecision,
) {
    let calls = calls.lock().unwrap();
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("native:"))
            .count(),
        usize::from(admitted)
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.as_str() == "release")
            .count(),
        usize::from(admitted)
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call.starts_with("review:"))
            .count(),
        usize::from(!permission_deny)
    );
    assert!(
        calls
            .iter()
            .filter(|call| call.starts_with("review:"))
            .all(|call| call.ends_with(":true"))
    );
    if !permission_deny && decision != guardrail::RuleDecision::Deny {
        assert!(calls.contains(&format!(
            "classified:Ask:{}",
            decision == guardrail::RuleDecision::HardReview
        )));
    }
}

fn decision_input() -> JsonValue {
    parse_json(r#"{"provider":"agent","request":{"state":{"action":"read"},"questions":[{"type":"choice","name":"route","instructions":"Choose from evidence","choices":[{"value":"keep"},{"value":"review"}]}]}}"#).unwrap()
}

fn decision_answer() -> &'static str {
    "decisions:\n  version: 1\n  answers[1]{name,type,answer,choice,score,confidence}:\n    route,choice,null,review,null,0.8"
}

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(value) = value else {
        panic!("expected object")
    };
    value.get(&key.into()).unwrap()
}

#[tokio::test]
async fn test022_decision_real_model_usage_refusal_errors_cancel_and_privacy() {
    for case in [
        "success",
        "refusal",
        "provider_error",
        "invalid_output",
        "tool_injection",
        "cancel",
        "invalid_request",
        "denied",
        "ceiling",
    ] {
        let fixture = Fixture::new();
        let root = fixture.session(
            "ses_decision",
            None,
            "prj_a",
            &fixture.temp.repo_a,
            2,
            (case == "ceiling").then(|| vec![rule("decision", "*", "deny")]),
        );
        AutonomyService::new(fixture.client())
            .set_goal(&root, Goal::new("Decide from evidence", None, None))
            .await
            .unwrap();
        fixture.set_rules(vec![rule("*", "*", "allow")]);
        if case == "denied" {
            fixture.push_rule("decision", "*", "deny");
        }
        let reply = match case {
            "provider_error" => ProviderReply::Rejected(serde_json::json!({"error":{"message":"sentinel-credential sentinel-account-id sentinel-email@example.test sentinel-private-header sentinel-raw-payload"}}).to_string()),
            "refusal" => ProviderReply::Stream(sse_text(&decision_answer().replace("choice,null,review,null,0.8", "refusal,null,null,null,0"))),
            "invalid_output" => ProviderReply::Stream(sse_text("sentinel-raw-payload")),
            "tool_injection" => ProviderReply::Stream(sse_tool("touch must-not-execute")),
            "cancel" => ProviderReply::Held,
            _ => ProviderReply::Stream(sse_text(decision_answer())),
        };
        let (endpoint, mut requests, server) = provider_server(vec![reply]).await;
        let sessions = SessionStoreService::new(fixture.client());
        let mut agent = agent::empty("decision".into());
        agent.hidden = true;
        agent.system = Some(agent::prompts::DECISION.into());
        let agents = Arc::new(agent::Service::new(vec![agent]));
        let service = Arc::new(decision::Service {
            store: sessions.clone(),
            agents,
            models: Arc::new(Models {
                models: Arc::new(model::Resolver::new(runner_catalog(&endpoint))),
                credentials: credential::Service::new(fixture.client()),
                auth: Default::default(),
                cursor: None,
                claude: None,
                store: sessions.clone(),
                settings: helper::Settings::default(),
            }),
            executor: Arc::new(ycoding_ai::route::Executor::new(
                ycoding_ai::route::Executor::http_client().unwrap(),
            )),
        });
        let tool = Arc::new(Decision {
            decisions: service.clone(),
            policy: fixture.leaf("prj_a", &fixture.temp.repo_a),
        });
        let context =
            Context::new("ses_decision", "build", "msg_decision", "call_decision").unwrap();
        let cancellation = context.cancellation.clone();
        let logs = support::Logs::default();
        let writer = logs.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_max_level(tracing::Level::TRACE)
            .with_writer(move || writer.clone())
            .finish();
        let _subscriber = tracing::subscriber::set_default(subscriber);
        let input = if case == "invalid_request" {
            parse_json(r#"{"provider":"agent","request":{"state":{"credential":"sentinel-credential","account":"sentinel-account-id","email":"sentinel-email@example.test","header":"sentinel-private-header","payload":"sentinel-raw-payload"},"questions":[{"type":"invalid","name":"route","instructions":"Classify"}]}}"#).unwrap()
        } else {
            decision_input()
        };
        let permitted = !matches!(case, "denied" | "ceiling" | "invalid_request");
        let task = tokio::spawn(async move { tool.settle(input, context).await });
        let request = if permitted {
            let request = within(requests.recv()).await.unwrap();
            assert!(!stringify_json(&request).contains("\"tools\":[{"));
            assert!(stringify_json(&request).contains("uncalibrated"));
            if case == "cancel" {
                cancellation.cancel();
            }
            Some(request)
        } else {
            None
        };
        let result = within(task).await.unwrap();
        let ledger = fixture
            .store()
            .snapshot()
            .unwrap()
            .scan::<RequestTable>(Bound::Unbounded, Bound::Unbounded, 128)
            .unwrap();
        assert_eq!(
            ledger.len(),
            usize::from(permitted),
            "{case}: no implicit retry or forbidden helper execution"
        );
        if matches!(case, "success" | "refusal") {
            let output = result.as_ref().unwrap();
            let response = field(&output.structured, "response");
            assert_eq!(
                field(field(response, "model"), "providerID"),
                &JsonValue::String("openai".into())
            );
            assert_eq!(
                field(field(response, "model"), "id"),
                &JsonValue::String("gpt-reasoning".into())
            );
            let expected = if case == "success" {
                r#"[{"name":"route","type":"choice","answer":null,"choice":"review","score":null,"confidence":0.8}]"#
            } else {
                r#"[{"name":"route","type":"refusal","answer":null,"choice":null,"score":null,"confidence":0}]"#
            };
            assert_eq!(field(response, "answers"), &parse_json(expected).unwrap());
            assert_eq!(ledger[0].source.as_str(), Some("decision"));
            assert_eq!(field(response, "usage"), ledger[0].tokens.value());
            assert_eq!(
                ledger[0].tokens.value(),
                &parse_json(r#"{"input":3,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}"#)
                    .unwrap()
            );
            if case == "refusal" {
                assert!(format!("{:?}", output.content).contains("Treat refusal as uncertainty"));
            }
        } else {
            assert!(result.is_err(), "{case}");
            if case == "cancel" {
                assert!(matches!(
                    result,
                    Err(ycoding_core::tools::registry::Failure::Cancelled)
                ));
            }
        }
        let durable = fixture
            .store()
            .snapshot()
            .unwrap()
            .scan::<EventTable>(Bound::Unbounded, Bound::Unbounded, 128)
            .unwrap();
        if permitted {
            assert!(
                durable.iter().any(
                    |event| event.type_.as_str() == Some("session.provider.request.recorded.1")
                ),
                "{case}: durable attempt settlement"
            );
            assert_eq!(
                durable
                    .iter()
                    .any(|event| event.type_.as_str() == Some("session.usage.recorded.1")),
                matches!(
                    case,
                    "success" | "refusal" | "invalid_output" | "tool_injection"
                ),
                "{case}: usage only when reported"
            );
        }
        let exposed = format!(
            "{result:?}\n{durable:?}\n{}\n{}",
            fixture.events_json(),
            String::from_utf8(logs.0.lock().unwrap().clone()).unwrap()
        );
        for sentinel in [
            "sentinel-credential",
            "sentinel-account-id",
            "sentinel-email@example.test",
            "sentinel-private-header",
            "sentinel-raw-payload",
        ] {
            assert!(
                !exposed.contains(sentinel),
                "{case}: sentinel escaped consumer errors/events/logs"
            );
        }
        if permitted {
            within(server).await.unwrap();
        } else {
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
        }
        assert!(requests.try_recv().is_err(), "{case}: no automatic retry");
        assert!(!fixture.temp.repo_a.join("must-not-execute").exists());
        assert_eq!(
            fixture.authority().session(&root, None).unwrap().configured,
            if matches!(case, "denied" | "ceiling") {
                vec![rule("*", "*", "allow"), rule("decision", "*", "deny")]
            } else {
                vec![rule("*", "*", "allow")]
            }
        );
        drop(request);
        let invalid = parse_json(
            r#"{"provider":"agent","request":{"state":"sentinel-raw-payload","questions":[]}}"#,
        )
        .unwrap();
        assert_eq!(
            service
                .evaluate(
                    &invalid,
                    decision::Invocation {
                        session_id: &root,
                        input_id: None,
                        attribution: ycoding_core::session::usage_attribution::Attribution::Unset,
                        cancellation: &Cancellation::default()
                    }
                )
                .await
                .unwrap_err(),
            decision::Error::InvalidRequest
        );
    }
}
