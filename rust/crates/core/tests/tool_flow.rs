//! SUITE-TOOLS composed acceptance flows (WP017-TOOLS).
//!
//! Case -> assertion map (from plans/rust-backend/test-suites.md TEST-045..048
//! and evidence/wp017-gap-ledger.md section 1):
//! - TEST-045 `test045_active_tool_manifest_matches_branch_map_and_agent_sets`:
//!   every tool the real registry makes available to the default agent (`god`)
//!   has a branch->assertion entry; built-in agents whose permission sets
//!   differ (hidden deny-all agents) expose the correspondingly smaller set.
//! - TEST-045 `test045_each_active_tool_drives_valid_invalid_denied_and_error_branches`:
//!   per-tool valid / absent-or-invalid / denied (zero effect) / error branches
//!   through `Registry::materialize(...).invoke(...)`, the bounded output
//!   consumer used by the runner.
//! - TEST-045 `test045_oversize_output_is_bounded_and_cancel_settles_without_effect`:
//!   oversize shell output is truncated/bounded; a cancelled CodeMode call
//!   fences later tool admission.
//! - TEST-045 `test045_runner_promotes_provider_tool_call_through_real_read_to_consumer`:
//!   F-RUN scripted provider endpoint -> real runner -> real `read` tool ->
//!   tool result visible in the next provider request (the consumer).
//! - TEST-046 `test046_file_repository_and_shell_effects_reach_the_consumer`:
//!   real read/glob/grep/edit/write/patch over Unicode, binary image, empty,
//!   oversize and missing files; symlink-escape and traversal rejection; real
//!   shell input -> file/output -> consumer.
//! - TEST-046 `test046_git_worktree_and_project_copy_outcomes_are_inspected`:
//!   created worktree branch, HEAD, tracked files and isolation, duplicate and
//!   denied creation with zero effect, project copy create/list/remove.
//! - TEST-046 `test046_pty_input_resize_output_status_disconnect_cancel_and_shutdown`:
//!   PTY cwd, input/resize -> output replay, exact exit status, viewer
//!   disconnect, owner fence, one-use tickets, cancellation and shutdown.
//! - TEST-046 `test046_restart_reconciles_orphaned_shell_trees_and_retains_the_lost_notice`:
//!   a new Core over the same file-backed store terminates an orphaned shell
//!   tree, retains the lost notice across a second restart until admitted, and
//!   never signals a PID whose identity differs from the ledger.
//! - TEST-046 `test046_runner_revert_restores_real_edit_and_write_tool_effects`:
//!   runner snapshot/revert restores real `edit` and `write` tool effects on
//!   a Git project (stage removes the created file and restores the edited
//!   one; clear re-applies both).
//! - TEST-047 `test047_codemode_domain_values_reach_tool_json_and_consumer`:
//!   domain/v5 values (paired/lone/mixed UTF-16, dynamic keys) through a real
//!   `execute` call to tool JSON values and on to the consumer result;
//!   semantic error prefixes and nested cancellation; no cap is introduced
//!   for an absent budget setting (unconfigured execute still completes a
//!   long-running nested call that a configured cap would cut).
//! - TEST-048 `test048_mcp_stdio_and_http_peers_cover_catalog_auth_pagination_and_reconnect`:
//!   real stdio (mcp_table.py) peer: paginated catalog, resources, resource
//!   traversal rejection, reconnect.
//! - TEST-048 `test048_http_peer_auth_pagination_deadline_elicitation_and_denied_effect`:
//!   HTTP and SSE stand-in peers with auth failure then success, stale closed
//!   connection, configured execution deadline, elicitation/Form reply, and
//!   permission denial blocking the peer effect.
//! - TEST-048 `test048_killed_stdio_peer_is_stale_fails_closed_and_reconnects_on_a_fresh_process`
//!   and `test048_service_disconnect_and_killed_peer_fail_the_held_tool_until_reconnect`:
//!   a SIGKILLed peer process cannot deliver; reconnect starts a fresh peer.
//! - TEST-048 `test048_skill_resource_traversal_and_stale_origin_reject_before_any_peer_fetch`:
//!   dot-dot, encoded, absolute, foreign-scheme and query URIs plus a foreign
//!   origin entry reject with zero peer fetches.
#![cfg(unix)]

include!("tool_fixture.rs");

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
mod support;

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::{Notify, mpsc},
};
use ycoding_ai::llm::{ToolOutput, ToolResultValue};
use ycoding_core::{
    platform::{
        filesystem::{mutation, search},
        git,
        shell::Shell,
    },
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        config::{Configuration, LoadOptions, Roots},
        credential, model,
    },
    session::{
        pending,
        run_coordinator::Coordinator,
        runner::{Local, Services, WallClock},
        store::Service,
    },
    tools::{
        builtin::{
            edit::Edit,
            filesystem::Paths,
            patch::Patch,
            read::Read,
            search::{Kind, Search},
            shell::{AUTO_BACKGROUND, Job, Jobs, Lease, Notice, NoticeFuture, ShellTool},
            webfetch::WebFetch,
            worktree::Worktree,
            write::Write,
        },
        context::{
            Context,
            consumers::{ConsumerFuture, ReadInstructions},
        },
        registry::{DynamicTool, Failure, Options, Registry, Tool},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, ObjectEncoder, parse_json, session, session_message, session_pending,
    stringify_json,
};

const WAIT: Duration = Duration::from_secs(30);

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(WAIT, future)
        .await
        .expect("operation exceeded the bounded harness deadline")
}

// ---------------------------------------------------------------------------
// Shared real-tool registry (the core-constructible production tool set).
// ---------------------------------------------------------------------------

#[derive(Default)]
struct NoInstructions;
impl ReadInstructions for NoInstructions {
    fn load(&self, _: Context, _: Vec<PathBuf>) -> ConsumerFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

struct ToolWorld {
    fixture: ToolFixture,
    registry: Registry,
    registration: ycoding_core::tools::registry::Registration,
}

fn tool_world() -> ToolWorld {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let files = Arc::new(mutation::Service::default());
    let search_service = Arc::new(
        search::Service::new(
            &fixture.root,
            search::Backend::Ripgrep {
                binary: "rg".into(),
            },
        )
        .unwrap(),
    );
    let entries: Vec<(String, Arc<dyn Tool>)> = vec![
        (
            "read".into(),
            Arc::new(Read {
                paths: fixture.paths(),
                policy: fixture.policy.clone(),
                instructions: Arc::new(NoInstructions),
                collator: Arc::new(|left, right| left.cmp(right)),
            }),
        ),
        (
            "write".into(),
            Arc::new(Write {
                paths: fixture.paths(),
                files: files.clone(),
                policy: fixture.policy.clone(),
            }),
        ),
        (
            "edit".into(),
            Arc::new(Edit {
                paths: fixture.paths(),
                files: files.clone(),
                policy: fixture.policy.clone(),
            }),
        ),
        (
            "patch".into(),
            Arc::new(Patch {
                paths: fixture.paths(),
                files,
                policy: fixture.policy.clone(),
            }),
        ),
        (
            "glob".into(),
            Arc::new(Search {
                kind: Kind::Glob,
                directory: fixture.root.clone(),
                data: fixture.root.join("data"),
                service: search_service.clone(),
                ripgrep: "rg".into(),
                policy: fixture.policy.clone(),
            }),
        ),
        (
            "grep".into(),
            Arc::new(Search {
                kind: Kind::Grep,
                directory: fixture.root.clone(),
                data: fixture.root.join("data"),
                service: search_service,
                ripgrep: "rg".into(),
                policy: fixture.policy.clone(),
            }),
        ),
        (
            "worktree".into(),
            Arc::new(Worktree {
                paths: fixture.paths(),
                policy: fixture.policy.clone(),
            }),
        ),
        (
            "webfetch".into(),
            Arc::new(WebFetch {
                policy: fixture.policy.clone(),
            }),
        ),
    ];
    let registration = registry.register(entries, Options::direct()).unwrap();
    ToolWorld {
        fixture,
        registry,
        registration,
    }
}

impl ToolWorld {
    async fn invoke(
        &self,
        name: &str,
        input: JsonValue,
    ) -> ycoding_core::tools::materialization::Settlement {
        within(
            self.registry
                .materialize(&[])
                .invoke(name, input, self.fixture.context()),
        )
        .await
        .unwrap()
    }
    fn cleanup(self) {
        drop(self.registration);
        self.fixture.cleanup();
    }
}

fn is_error(settlement: &ycoding_core::tools::materialization::Settlement) -> bool {
    matches!(settlement.result, ToolResultValue::Error(_))
}

fn error_text(settlement: &ycoding_core::tools::materialization::Settlement) -> String {
    match &settlement.result {
        ToolResultValue::Error(JsonValue::String(text)) => text.to_utf8().unwrap(),
        other => panic!("expected an error result, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// TEST-045: active-tool manifest.
// ---------------------------------------------------------------------------

/// Branch labels asserted for every active tool. Adding a registered tool
/// without a map entry (or removing one) fails the manifest test below.
const BRANCH_MAP: &[(&str, &str)] = &[
    ("edit", "valid+invalid+denied-zero-effect+error"),
    ("glob", "valid+invalid+denied+error"),
    ("grep", "valid+invalid+denied+error"),
    ("patch", "valid+invalid+denied-zero-effect+error"),
    ("read", "valid+invalid+denied+error+oversize"),
    ("webfetch", "valid+invalid+denied+error"),
    ("worktree", "valid+invalid+denied+error"),
    ("write", "valid+invalid+denied-zero-effect+error"),
];

#[tokio::test]
async fn test045_active_tool_manifest_matches_branch_map_and_agent_sets() {
    let world = tool_world();
    let roots = Roots::development(&world.fixture.root).unwrap();
    let agents = agent::builtin::catalog(&roots).unwrap();
    let default = agents
        .iter()
        .find(|info| info.id.as_str() == Some(agent::DEFAULT_ID))
        .expect("default agent exists");
    let active: BTreeSet<String> = world
        .registry
        .materialize(&default.permissions)
        .definitions
        .iter()
        .map(|definition| definition.name.as_str().unwrap().to_owned())
        .collect();
    let mapped: BTreeSet<String> = BRANCH_MAP
        .iter()
        .map(|(name, _)| name.to_string())
        .collect();
    assert_eq!(
        active, mapped,
        "every active tool must have a branch->assertion entry; active={active:?} mapped={mapped:?}"
    );
    // Agents whose sets differ: hidden system agents deny every tool.
    for hidden in agents.iter().filter(|info| info.hidden) {
        assert!(
            world
                .registry
                .materialize(&hidden.permissions)
                .definitions
                .is_empty(),
            "hidden agent {} must expose no tools",
            hidden.id.as_str().unwrap()
        );
    }
    // Primary and subagent built-ins share the allow-by-default set here;
    // the subagent-deny rule targets the `subagent` tool, which is not in
    // this registry, so their visible sets must not silently diverge.
    for info in agents.iter().filter(|info| !info.hidden) {
        let names: BTreeSet<String> = world
            .registry
            .materialize(&info.permissions)
            .definitions
            .iter()
            .map(|definition| definition.name.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            names,
            active,
            "agent {} tool set diverged",
            info.id.as_str().unwrap()
        );
    }
    world.cleanup();
}

#[tokio::test]
async fn test045_each_active_tool_drives_valid_invalid_denied_and_error_branches() {
    let world = tool_world();
    fs::write(world.fixture.root.join("note.txt"), "before\nneedle\n").unwrap();

    // valid branches, each reaching its consumer-visible result.
    let read = world
        .invoke("read", parse_json(r#"{"path":"note.txt"}"#).unwrap())
        .await;
    assert!(!is_error(&read), "{}", error_text(&read));
    let written = world
        .invoke(
            "write",
            parse_json(r#"{"path":"made.txt","content":"created"}"#).unwrap(),
        )
        .await;
    assert!(!is_error(&written));
    assert_eq!(
        fs::read_to_string(world.fixture.root.join("made.txt")).unwrap(),
        "created"
    );
    let edited = world
        .invoke(
            "edit",
            parse_json(r#"{"path":"note.txt","oldString":"before","newString":"after"}"#).unwrap(),
        )
        .await;
    assert!(!is_error(&edited));
    let patched = world
        .invoke(
            "patch",
            parse_json(
                r#"{"patchText":"*** Begin Patch\n*** Update File: made.txt\n@@\n-created\n+patched\n*** End Patch"}"#,
            )
            .unwrap(),
        )
        .await;
    assert!(!is_error(&patched));
    assert_eq!(
        fs::read_to_string(world.fixture.root.join("made.txt")).unwrap(),
        "patched\n"
    );
    for args in [
        vec!["init", "-b", "main"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "initial",
        ],
    ] {
        assert!(
            Command::new("git")
                .args(&args)
                .current_dir(&world.fixture.root)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    for (name, input) in [
        ("glob", r#"{"pattern":"*.txt"}"#),
        ("grep", r#"{"pattern":"needle"}"#),
        ("worktree", r#"{"action":"list"}"#),
    ] {
        let result = world.invoke(name, parse_json(input).unwrap()).await;
        assert!(!is_error(&result), "{name}: {}", error_text(&result));
    }

    // absent / invalid input branches: typed errors, no effect.
    for (name, input) in [
        ("read", "{}"),
        ("write", r#"{"path":"x.txt"}"#),
        ("edit", r#"{"path":"note.txt","oldString":"after"}"#),
        ("patch", r#"{"patchText":"not a patch"}"#),
        ("glob", "{}"),
        ("grep", "{}"),
        ("worktree", r#"{"action":"bogus"}"#),
        ("webfetch", "{}"),
    ] {
        let result = world.invoke(name, parse_json(input).unwrap()).await;
        assert!(is_error(&result), "{name} invalid input must error");
    }
    assert!(!world.fixture.root.join("x.txt").exists());

    // error branches: missing files surface as tool errors, not success.
    let missing = world
        .invoke("read", parse_json(r#"{"path":"absent.txt"}"#).unwrap())
        .await;
    assert!(is_error(&missing));

    // denied branches: zero filesystem effect.
    // Mutation tools share the `edit` permission action (see tool_write).
    world.fixture.deny("edit", "*");
    let before = fs::read_to_string(world.fixture.root.join("note.txt")).unwrap();
    let denied_write = world
        .invoke(
            "write",
            parse_json(r#"{"path":"denied.txt","content":"no"}"#).unwrap(),
        )
        .await;
    assert!(is_error(&denied_write));
    assert!(!world.fixture.root.join("denied.txt").exists());
    let denied_edit = world
        .invoke(
            "edit",
            parse_json(r#"{"path":"note.txt","oldString":"after","newString":"x"}"#).unwrap(),
        )
        .await;
    assert!(is_error(&denied_edit));
    assert_eq!(
        fs::read_to_string(world.fixture.root.join("note.txt")).unwrap(),
        before
    );
    let denied_patch = world
        .invoke(
            "patch",
            parse_json(
                r#"{"patchText":"*** Begin Patch\n*** Update File: made.txt\n@@\n-patched\n+no\n*** End Patch"}"#,
            )
            .unwrap(),
        )
        .await;
    assert!(is_error(&denied_patch));
    assert_eq!(
        fs::read_to_string(world.fixture.root.join("made.txt")).unwrap(),
        "patched\n"
    );

    // unknown tool: typed `tool.unknown` consumer error.
    let unknown = world.invoke("nope", JsonValue::Null).await;
    assert!(is_error(&unknown));
    assert_eq!(unknown.error.unwrap().r#type.as_str(), Some("tool.unknown"));
    world.cleanup();
}

// ---------------------------------------------------------------------------
// Shell world (real spawned processes through the real ShellTool).
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Recorder {
    notices: Mutex<Vec<Notice>>,
    foreground: Mutex<Vec<Job>>,
}
impl Jobs for Recorder {
    fn foreground(&self, job: &Job, _: Arc<Notify>) -> Lease {
        self.foreground.lock().unwrap().push(job.clone());
        Box::new(())
    }
    fn background(&self, _: &Job) -> Lease {
        Box::new(())
    }
    fn deliver(&self, notice: Notice) -> NoticeFuture {
        self.notices.lock().unwrap().push(notice);
        Box::pin(async { Ok(()) })
    }
}

struct ShellWorld {
    fixture: ToolFixture,
    store: ycoding_store::Store,
    shell: Arc<Shell>,
    tool: Arc<ShellTool>,
}
impl ShellWorld {
    async fn new() -> Self {
        let fixture = ToolFixture::new();
        fixture.authority.session("ses_tool", None, 0, false, None);
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([31; 16], 1),
        )
        .unwrap();
        let roots = Roots::development(&fixture.root).unwrap();
        let configuration = Arc::new(
            Configuration::load(LoadOptions {
                directory: fixture.root.clone(),
                roots: roots.clone(),
                project: false,
                content: Some("{\"shell\":\"/bin/sh\"}".into()),
                file: None,
                env: Default::default(),
            })
            .unwrap(),
        );
        let shell = Arc::new(
            Shell::new(&roots, fixture.root.clone(), "project", store.client())
                .await
                .unwrap(),
        );
        let jobs = Arc::new(Recorder::default());
        let tool = Arc::new(ShellTool {
            shell: shell.clone(),
            configuration,
            paths: fixture.paths(),
            policy: fixture.policy.clone(),
            jobs: jobs.clone(),
            auto_background: AUTO_BACKGROUND,
        });
        Self {
            fixture,
            store,
            shell,
            tool,
        }
    }
    async fn call(&self, input: serde_json::Value) -> Result<ToolOutput, Failure> {
        within(self.tool.settle(
            parse_json(&input.to_string()).unwrap(),
            self.fixture.context(),
        ))
        .await
    }
    async fn finish(self) {
        self.shell.shutdown().await.unwrap();
        assert!(
            self.shell.list().is_empty(),
            "owned shell jobs must be gone"
        );
        drop(self.tool);
        drop(self.shell);
        self.store.shutdown().unwrap();
        self.fixture.cleanup();
    }
}

fn structured(output: &ToolOutput) -> serde_json::Value {
    serde_json::from_str(&stringify_json(&output.structured)).unwrap()
}

#[tokio::test]
async fn test045_oversize_output_is_bounded_and_cancel_settles_without_effect() {
    let world = ShellWorld::new().await;
    let registry = world.fixture.registry();
    let _registration = registry
        .register(
            vec![("shell".into(), world.tool.clone() as Arc<dyn Tool>)],
            Options::direct(),
        )
        .unwrap();
    let settlement = within(registry.materialize(&[]).invoke(
        "shell",
        parse_json(r#"{"command":"head -c 1100000 /dev/zero | tr '\\0' 'x'"}"#).unwrap(),
        world.fixture.context(),
    ))
    .await
    .unwrap();
    let output = settlement.output.expect("shell output");
    assert_eq!(structured(&output)["truncated"], serde_json::json!(true));
    let total: usize = output
        .content
        .iter()
        .map(|item| match item {
            ycoding_schema::llm::ToolContent::Text(text) => text.text.len(),
            _ => 0,
        })
        .sum();
    assert!(
        total < 1_100_000,
        "bounded consumer output, got {total} bytes"
    );
    world.finish().await;

    // Cancel: a CodeMode tool that only settles on cancellation must fence
    // the execute call; no success is fabricated and no later call runs.
    let registry = Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &Roots::development(&std::env::temp_dir().join("ycoding-tool-flow-execute")).unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    );
    let ran = Arc::new(Mutex::new(Vec::new()));
    let seen = ran.clone();
    let _scope = registry
        .register(
            vec![(
                "pending".into(),
                Arc::new(DynamicTool::new(
                    "Pending",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    move |_, context: Context| {
                        let seen = seen.clone();
                        Box::pin(async move {
                            seen.lock().unwrap().push("pending".to_string());
                            context.cancellation.cancelled().await;
                            Err(Failure::Cancelled)
                        })
                    },
                )) as Arc<dyn Tool>,
            )],
            Options::default(),
        )
        .unwrap();
    let context = Context::new("ses_flow", "build", "msg_flow", "call_flow").unwrap();
    context.cancellation.cancel();
    let cancelled = within(registry.materialize(&[]).invoke(
        "execute",
        parse_json(r#"{"code":"await tools.pending({}); return \"unreachable\""}"#).unwrap(),
        context,
    ))
    .await
    .unwrap();
    assert!(
        !matches!(cancelled.result, ToolResultValue::Text(ref text) if text == &JsonValue::String("unreachable".into())),
        "cancelled execute must not claim success: {:?}",
        cancelled.result
    );
    assert!(
        ran.lock().unwrap().is_empty(),
        "a cancelled execute must fence later tool admission"
    );
}

// ---------------------------------------------------------------------------
// F-RUN: scripted provider endpoint + real runner.
// ---------------------------------------------------------------------------

async fn provider_server(
    replies: Vec<&'static str>,
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
            send.send(
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap(),
            )
            .unwrap();
            let response = format!(
                "HTTP/1.1 200 Response\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, receive, task)
}

fn runner_registry(root: &std::path::Path) -> Arc<Registry> {
    Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &Roots::development(&root.join("output-store")).unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ))
}

fn runner_local(
    store: &ycoding_store::Store,
    endpoint: &str,
    registry: Arc<Registry>,
    agents: Vec<ycoding_schema::agent::Info>,
) -> Local {
    runner_local_snapshots(store, endpoint, registry, agents, None)
}

fn runner_local_snapshots(
    store: &ycoding_store::Store,
    endpoint: &str,
    registry: Arc<Registry>,
    agents: Vec<ycoding_schema::agent::Info>,
    snapshots: Option<Arc<ycoding_core::session::snapshot::GitSnapshots>>,
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
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(agents)),
        credentials: credential::Service::new(store.client()),
        tools: registry,
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-tool-flow-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
        skill_resolver: None,
        snapshots: snapshots.map(|snapshots| {
            snapshots as Arc<dyn ycoding_core::session::revert::Snapshots + Send + Sync>
        }),
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        claude: None,
        auth: None,
    })
}

async fn admit(service: &Service) {
    service
        .admit(pending::Request {
            id: session_message::Id::new("msg_input").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &ObjectEncoder::new()
                    .field("type", "user")
                    .field(
                        "data",
                        &ObjectEncoder::new().field("text", "Use the tool").finish(),
                    )
                    .field("delivery", "steer")
                    .finish(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_input").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

const TEXT_REPLY: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const READ_TOOL_REPLY: &str = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_read\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"note.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";

#[tokio::test]
async fn test045_runner_promotes_provider_tool_call_through_real_read_to_consumer() {
    let fixture = ToolFixture::new();
    fixture.authority.session("ses_one", None, 0, false, None);
    fs::write(fixture.root.join("note.txt"), "runner-visible needle\n").unwrap();
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let registry = runner_registry(&fixture.root);
    let _registration = registry
        .register(
            vec![(
                "read".into(),
                Arc::new(Read {
                    paths: Arc::new(Paths {
                        directory: fixture.root.clone(),
                        data: fixture.root.join("data"),
                        git: Arc::new(git::Service::new(1024 * 1024)),
                    }),
                    policy: fixture.policy.clone(),
                    instructions: Arc::new(NoInstructions),
                    collator: Arc::new(|left, right| left.cmp(right)),
                }) as Arc<dyn Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    let (endpoint, mut requests, server) = provider_server(vec![READ_TOOL_REPLY, TEXT_REPLY]).await;
    let coordinator = Coordinator::new(Arc::new(runner_local(
        &store,
        &endpoint,
        registry,
        vec![agent::empty("test".into())],
    )));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    let _first = within(requests.recv()).await.unwrap();
    let second = within(requests.recv()).await.unwrap();
    assert!(
        stringify_json(&second).contains("runner-visible needle"),
        "tool result must reach the consumer request: {}",
        stringify_json(&second)
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    fixture.cleanup();
}

// ---------------------------------------------------------------------------
// TEST-046: file, repository and shell effects.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test046_file_repository_and_shell_effects_reach_the_consumer() {
    let world = tool_world();
    // Unicode content through write -> read, with the value forms accepted.
    let unicode = "héllo — ünïcode ✓\nsecond line\n";
    let written = world
        .invoke(
            "write",
            JsonValue::Object({
                let mut object = ycoding_schema::JsonObject::new();
                object.insert("path".into(), JsonValue::String("unicode.txt".into()));
                object.insert("content".into(), JsonValue::String(unicode.into()));
                object
            }),
        )
        .await;
    assert!(!is_error(&written));
    let read = world
        .invoke("read", parse_json(r#"{"path":"unicode.txt"}"#).unwrap())
        .await;
    assert!(stringify_json(&read.output.unwrap().structured).contains("héllo"));

    // Binary image: real PNG bytes round-trip through read as file content.
    let png: Vec<u8> = vec![
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, b'I', b'H', b'D', b'R',
    ];
    fs::write(world.fixture.root.join("image.png"), &png).unwrap();
    let image = world
        .invoke("read", parse_json(r#"{"path":"image.png"}"#).unwrap())
        .await;
    assert!(!is_error(&image), "{}", error_text(&image));

    // Empty, oversize and missing files.
    fs::write(world.fixture.root.join("empty.txt"), "").unwrap();
    let empty = world
        .invoke("read", parse_json(r#"{"path":"empty.txt"}"#).unwrap())
        .await;
    assert!(!is_error(&empty));
    fs::write(world.fixture.root.join("big.txt"), "x".repeat(500_000)).unwrap();
    let big = world
        .invoke("read", parse_json(r#"{"path":"big.txt"}"#).unwrap())
        .await;
    assert!(!is_error(&big));
    assert!(
        stringify_json(&big.output.unwrap().structured).len() < 500_000,
        "oversize read must be bounded for the consumer"
    );
    let missing = world
        .invoke("read", parse_json(r#"{"path":"missing.txt"}"#).unwrap())
        .await;
    assert!(is_error(&missing));

    // Symlink escape and path traversal are rejected with zero effect.
    let outside = world
        .fixture
        .root
        .parent()
        .unwrap()
        .join(format!("tool-flow-outside-{}", std::process::id()));
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        outside.join("secret.txt"),
        world.fixture.root.join("escape.txt"),
    )
    .unwrap();
    let escaped = world
        .invoke("read", parse_json(r#"{"path":"escape.txt"}"#).unwrap())
        .await;
    assert!(
        is_error(&escaped),
        "symlink escape must reject: {:?}",
        escaped.result
    );
    world.fixture.deny("external_directory", "*");
    let escape_name = format!("tool-flow-escape-{}.txt", std::process::id());
    let traversal = world
        .invoke(
            "write",
            parse_json(&format!(r#"{{"path":"../{escape_name}","content":"no"}}"#)).unwrap(),
        )
        .await;
    assert!(is_error(&traversal));
    assert!(
        !world
            .fixture
            .root
            .parent()
            .unwrap()
            .join(&escape_name)
            .exists()
    );
    fs::remove_dir_all(&outside).unwrap();

    world.cleanup();

    // Shell: input -> file/output -> consumer, plus nonzero exit.
    let shell = ShellWorld::new().await;
    let root = shell.fixture.root.clone();
    let output = shell
        .call(serde_json::json!({"command": "printf 'shell-needle' > made-by-shell.txt && cat made-by-shell.txt"}))
        .await
        .unwrap();
    assert_eq!(structured(&output)["exit"], 0);
    assert_eq!(
        fs::read_to_string(root.join("made-by-shell.txt")).unwrap(),
        "shell-needle"
    );
    let nonzero = shell
        .call(serde_json::json!({"command": "exit 7"}))
        .await
        .unwrap();
    assert_eq!(structured(&nonzero)["exit"], 7);
    shell.finish().await;
}

#[tokio::test]
async fn test046_runner_revert_restores_real_edit_and_write_tool_effects() {
    use ycoding_core::session::{revert, snapshot::GitSnapshots};
    // Snapshot project with a tracked file, edited by a real runner tool call.
    let fixture = ToolFixture::new();
    let project_root = fixture.root.join("snapshot-root");
    let project = project_root.join("project");
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("tracked.txt"), "original\n").unwrap();
    for args in [vec!["init"], vec!["add", "."]] {
        assert!(
            Command::new("git")
                .args(args)
                .current_dir(&project)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let registry = runner_registry(&project_root);
    fixture.authority.session("ses_one", None, 1, false, None);
    let paths = Arc::new(Paths {
        directory: project.clone(),
        data: project_root.join("data"),
        git: Arc::new(git::Service::new(1024 * 1024)),
    });
    let files = Arc::new(mutation::Service::default());
    let _registration = registry
        .register(
            vec![
                (
                    "edit".into(),
                    Arc::new(Edit {
                        paths: paths.clone(),
                        files: files.clone(),
                        policy: fixture.policy.clone(),
                    }) as Arc<dyn Tool>,
                ),
                (
                    "write".into(),
                    Arc::new(Write {
                        paths,
                        files,
                        policy: fixture.policy.clone(),
                    }) as Arc<dyn Tool>,
                ),
            ],
            Options::direct(),
        )
        .unwrap();
    const EDIT_TOOL_REPLY: &str = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_edit\",\"type\":\"function\",\"function\":{\"name\":\"edit\",\"arguments\":\"{\\\"path\\\":\\\"tracked.txt\\\",\\\"oldString\\\":\\\"original\\\",\\\"newString\\\":\\\"changed\\\"}\"}},{\"index\":1,\"id\":\"call_write\",\"type\":\"function\",\"function\":{\"name\":\"write\",\"arguments\":\"{\\\"path\\\":\\\"created.txt\\\",\\\"content\\\":\\\"new file\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
    let (endpoint, mut requests, server) = provider_server(vec![EDIT_TOOL_REPLY, TEXT_REPLY]).await;
    let snapshots = Arc::new(GitSnapshots::new(
        Arc::new(git::Service::new(16 * 1024 * 1024)),
        project_root.join("data"),
        "prj_one".into(),
        project.clone(),
        project.clone(),
        true,
    ));
    let local = runner_local_snapshots(
        &store,
        &endpoint,
        registry,
        vec![agent::empty("test".into())],
        Some(snapshots.clone()),
    );
    let coordinator = Coordinator::new(Arc::new(local));
    let id = session::Id::new("ses_one").unwrap();
    within(coordinator.run(&id)).await.unwrap();
    let _first = within(requests.recv()).await.unwrap();
    let second = within(requests.recv()).await.unwrap();
    let consumer = stringify_json(&second);
    assert!(consumer.contains("Edited file successfully"), "{consumer}");
    assert!(consumer.contains("call_write"), "{consumer}");
    assert_eq!(
        fs::read_to_string(project.join("tracked.txt")).unwrap(),
        "changed\n"
    );
    assert_eq!(
        fs::read_to_string(project.join("created.txt")).unwrap(),
        "new file"
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();

    // Revert boundary: staging the revert restores the tracked file, and
    // clearing the staged revert re-applies the tool edit.
    let boundary = session_message::Id::new("msg_input").unwrap();
    let plan = revert::plan(&store.snapshot().unwrap(), &id, &boundary).unwrap();
    assert_eq!(plan.len(), 2, "edit and write are both captured: {plan:?}");
    let session = service.get(&id).unwrap().unwrap();
    revert::stage(&service, snapshots.as_ref(), &session, &boundary, true, 3)
        .await
        .unwrap();
    assert_eq!(
        fs::read_to_string(project.join("tracked.txt")).unwrap(),
        "original\n",
        "staged revert must restore the pre-tool content"
    );
    assert!(
        !project.join("created.txt").exists(),
        "staged revert must remove the file the write tool created"
    );
    revert::clear(
        &service,
        snapshots.as_ref(),
        &service.get(&id).unwrap().unwrap(),
        4,
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read_to_string(project.join("tracked.txt")).unwrap(),
        "changed\n",
        "clearing the staged revert must re-apply the tool edit"
    );
    assert_eq!(
        fs::read_to_string(project.join("created.txt")).unwrap(),
        "new file",
        "clearing the staged revert must re-apply the tool write"
    );
    fs::remove_dir_all(&project_root).unwrap();
    fixture.cleanup();
}

// ---------------------------------------------------------------------------
// TEST-047: CodeMode.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test047_codemode_domain_values_reach_tool_json_and_consumer() {
    let registry = Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &Roots::development(&std::env::temp_dir().join("ycoding-tool-flow-codemode")).unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    );
    let received = Arc::new(Mutex::new(Vec::new()));
    let seen = received.clone();
    let _scope = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(DynamicTool::new(
                    "Echo input as JSON",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    move |input, _| {
                        let seen = seen.clone();
                        Box::pin(async move {
                            seen.lock().unwrap().push(input.clone());
                            Ok(ToolOutput {
                                structured: input,
                                content: vec![],
                            })
                        })
                    },
                )) as Arc<dyn Tool>,
            )],
            Options {
                namespace: Some("flow".into()),
                codemode: true,
            },
        )
        .unwrap();
    let context = Context::new("ses_flow", "build", "msg_flow", "call_flow").unwrap();
    // Paired + lone UTF-16 units and a dynamic key travel domain -> execute
    // -> tool JSON -> consumer without rejection or replacement.
    let code = "const key = 'dyn' + 'amic'; const value = {}; value[key] = '\\ud83d\\ude00\\ud800x'; return await tools.flow.echo(value);";
    let mut input = ycoding_schema::JsonObject::new();
    input.insert("code".into(), JsonValue::String(code.into()));
    let output = within(registry.materialize(&[]).invoke(
        "execute",
        JsonValue::Object(input),
        context.clone(),
    ))
    .await
    .unwrap();
    assert_eq!(received.lock().unwrap().len(), 1);
    let tool_json = stringify_json(&received.lock().unwrap()[0]);
    assert!(tool_json.contains("dynamic"), "{tool_json}");
    assert!(
        tool_json.contains("\\ud800"),
        "lone unit preserved: {tool_json}"
    );
    assert!(
        matches!(&output.result, ToolResultValue::Text(JsonValue::String(text)) if text.to_utf8().unwrap().contains("😀")),
        "consumer sees the paired value: {:?}",
        output.result
    );

    // Semantic error prefix: a thrown domain error keeps its prefix and the
    // execute call reports an error rather than a fabricated success.
    let failed = within(registry.materialize(&[]).invoke(
        "execute",
        parse_json(r#"{"code":"throw new Error('ToolFailure: lookup refused')"}"#).unwrap(),
        context.clone(),
    ))
    .await
    .unwrap();
    assert!(
        format!("{:?}", failed.result).contains("ToolFailure"),
        "{:?}",
        failed.result
    );

    // Nested cancellation fences later admission (covered for the pending
    // tool in TEST-045) and an absent budget introduces no cap: a nested
    // call chain of depth beyond any single configured step still completes.
    let deep = within(
        registry.materialize(&[]).invoke(
            "execute",
            parse_json(
                r#"{"code":"let v = 0; for (let i = 0; i < 50; i++) { v = (await tools.flow.echo({value: i})).value; } return v;"}"#,
            )
            .unwrap(),
            context,
        ),
    )
    .await
    .unwrap();
    assert!(
        matches!(&deep.result, ToolResultValue::Text(JsonValue::String(text)) if text.to_utf8().unwrap().contains("49")),
        "absent budget must not cap the nested chain: {:?}",
        deep.result
    );
}

// ---------------------------------------------------------------------------
// TEST-048: MCP peers.
// ---------------------------------------------------------------------------

fn mcp_table_config(fixture: &ToolFixture, name: &str, table: serde_json::Value) -> PathBuf {
    let state = fixture.root.join(format!("{name}.json"));
    let mut table = table;
    table["log"] = serde_json::json!(fixture.root.join(format!("{name}.log")));
    fs::write(&state, table.to_string()).unwrap();
    state
}

#[tokio::test]
async fn test048_mcp_stdio_and_http_peers_cover_catalog_auth_pagination_and_reconnect() {
    use ycoding_core::resources::mcp::client::{Connection, Hooks};
    // Real stdio peer driven by the shared mcp_table.py stand-in.
    let fixture = ToolFixture::new();
    let state = mcp_table_config(
        &fixture,
        "stdio-peer",
        serde_json::json!({
            "capabilities": {"tools": {}, "resources": {}},
            "responses": {
                "tools/list": {"": {"tools": [{"name": "first", "inputSchema": {"type": "object"}}], "nextCursor": "page-2"}, "page-2": {"tools": [{"name": "second", "inputSchema": {"type": "object"}}]}},
                "resources/list": {"": {"resources": [{"name": "readme", "uri": "test://readme"}]}},
                "resources/read": {"test://readme": {"contents": [{"uri": "test://readme", "text": "peer text"}]}}
            },
            "calls": {"first": {"result": {"content": [{"type": "text", "text": "called"}]}}}
        }),
    );
    let config = ycoding_schema::mcp::ServerConfig::decode(
        &parse_json(
            &serde_json::json!({"type": "local", "command": ["python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"), state]}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let connection = within(Connection::connect(
        "stdio-peer",
        &config,
        &fixture.root,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    ))
    .await
    .unwrap();
    let tools = within(connection.tools()).await.unwrap();
    assert_eq!(tools.len(), 2, "paginated catalog: {tools:?}");
    let resources = within(connection.resources()).await.unwrap();
    assert_eq!(resources[0]["uri"], "test://readme");
    let read = within(connection.read_resource("test://readme", None))
        .await
        .unwrap();
    assert!(read.unwrap().to_string().contains("peer text"));
    // Resource traversal: an unknown/traversing URI is rejected by the peer
    // boundary and returns an error, never fetched content.
    let traversal = connection.read_resource("../secret", None).await;
    assert!(traversal.is_err(), "traversal must reject: {traversal:?}");
    let called = within(connection.call_tool("first", serde_json::json!({}), None))
        .await
        .unwrap();
    assert!(!called.is_error, "stdio call must succeed: {called:?}");
    assert!(format!("{:?}", called.content).contains("called"));
    connection.close().await.unwrap();
    // Reconnect: a fresh connection to the same peer succeeds (stale peer
    // state cannot register or deliver).
    let reconnected = within(Connection::connect(
        "stdio-peer",
        &config,
        &fixture.root,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    ))
    .await
    .unwrap();
    assert_eq!(within(reconnected.tools()).await.unwrap().len(), 2);
    reconnected.close().await.unwrap();
    fixture.cleanup();
}

// ---------------------------------------------------------------------------
// TEST-048 (continued): HTTP/SSE auth peer, deadline, elicitation/Form,
// stale peer and permission-denied peer effect through McpTools.
// ---------------------------------------------------------------------------

fn peer_skill_entry(name: &str, second: &str) -> serde_json::Value {
    let digest = ycoding_core::resources::mcp::skills::digest(b"# Guide\n");
    serde_json::json!({
        "uri": format!("skill://{name}/SKILL.md"),
        "frontmatter": {"name": name, "description": "d"},
        "resources": [
            {"uri": format!("skill://{name}/SKILL.md"), "digest": digest, "size": 8},
            {"uri": second, "digest": digest, "size": 8}
        ]
    })
}

struct HttpPeer {
    url: String,
    task: tokio::task::JoinHandle<()>,
    reads: Arc<std::sync::atomic::AtomicUsize>,
}

impl HttpPeer {
    async fn new(sse: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = reads.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let reads = counter.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let headers_end = loop {
                        let read = stream.read(&mut buffer).await.unwrap();
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        if let Some(offset) =
                            request.windows(4).position(|window| window == b"\r\n\r\n")
                        {
                            break offset + 4;
                        }
                    };
                    let headers = String::from_utf8(request[..headers_end].to_vec()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|line| {
                            line.split_once(':')
                                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    while request.len() < headers_end + length {
                        let read = stream.read(&mut buffer).await.unwrap();
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                    }
                    if !headers
                        .lines()
                        .any(|line| line.eq_ignore_ascii_case("authorization: Bearer good"))
                    {
                        let body = r#"{"error":"unauthorized"}"#;
                        let response = format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        stream.write_all(response.as_bytes()).await.unwrap();
                        return;
                    }
                    let body: serde_json::Value =
                        serde_json::from_slice(&request[headers_end..headers_end + length])
                            .unwrap();
                    if body.get("id").is_none() {
                        let response = "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                        stream.write_all(response.as_bytes()).await.unwrap();
                        return;
                    }
                    let params = &body["params"];
                    let result = match body["method"].as_str().unwrap() {
                        "initialize" => {
                            serde_json::json!({"protocolVersion": "2025-11-25", "serverInfo": {"name": "http-peer", "version": "1"}, "capabilities": {"tools": {}, "resources": {}, "extensions": {"io.modelcontextprotocol/skills": {"directoryRead": true}}}})
                        }
                        "skills/list" => {
                            serde_json::json!({"resultType": "complete", "ttlMs": 0, "cacheScope": "server", "skills": [peer_skill_entry("a", "skill://a/references/GUIDE.md")]})
                        }
                        "skills/get" => {
                            let entry = if params["uri"] == "skill://evil/SKILL.md" {
                                peer_skill_entry("evil", "skill://evil/../b/SKILL.md")
                            } else {
                                peer_skill_entry("a", "skill://a/references/GUIDE.md")
                            };
                            serde_json::json!({"resultType": "complete", "ttlMs": 0, "cacheScope": "server", "skill": entry})
                        }
                        "tools/list" => {
                            if params.get("cursor").is_none() {
                                serde_json::json!({"tools": [{"name": "first", "inputSchema": {"type": "object"}}], "nextCursor": "page-2"})
                            } else {
                                serde_json::json!({"tools": [{"name": "second", "inputSchema": {"type": "object"}}]})
                            }
                        }
                        "tools/call" => {
                            serde_json::json!({"content": [{"type": "text", "text": "http-called"}]})
                        }
                        "resources/list" => {
                            serde_json::json!({"resources": [{"name": "readme", "uri": "test://readme"}]})
                        }
                        "resources/read" => {
                            reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            let text = if params["uri"]
                                .as_str()
                                .is_some_and(|uri| uri.starts_with("skill://"))
                            {
                                "# Guide\n"
                            } else {
                                "http peer text"
                            };
                            serde_json::json!({"contents": [{"uri": params["uri"], "text": text}]})
                        }
                        _ => {
                            let response_body = serde_json::json!({"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32601, "message": "Method not found"}});
                            let payload = response_body.to_string();
                            let response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                                payload.len()
                            );
                            stream.write_all(response.as_bytes()).await.unwrap();
                            return;
                        }
                    };
                    let payload =
                        serde_json::json!({"jsonrpc": "2.0", "id": body["id"], "result": result})
                            .to_string();
                    let (content_type, payload) = if sse {
                        (
                            "text/event-stream",
                            format!("event: message\ndata: {payload}\n\n"),
                        )
                    } else {
                        ("application/json", payload)
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                        payload.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        Self { url, task, reads }
    }
    fn config(&self, token: Option<&str>) -> ycoding_schema::mcp::ServerConfig {
        let headers = match token {
            Some(token) => serde_json::json!({"Authorization": format!("Bearer {token}")}),
            None => serde_json::json!({}),
        };
        ycoding_schema::mcp::ServerConfig::decode(
            &parse_json(
                &serde_json::json!({"type": "remote", "url": self.url, "oauth": false, "headers": headers})
                    .to_string(),
            )
            .unwrap(),
        )
        .unwrap()
    }
}

#[tokio::test]
async fn test048_http_peer_auth_pagination_deadline_elicitation_and_denied_effect() {
    use ycoding_core::resources::mcp::client::{Connection, Hooks};
    let fixture = ToolFixture::new();

    // HTTP and SSE peers: auth failure first, then auth success with a
    // paginated catalog and resource read.
    for sse in [false, true] {
        let peer = HttpPeer::new(sse).await;
        let rejected = Connection::connect(
            "http-peer",
            &peer.config(Some("wrong")),
            &fixture.root,
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        )
        .await;
        assert!(rejected.is_err(), "bad auth must fail the connection");
        let connection = within(Connection::connect(
            "http-peer",
            &peer.config(Some("good")),
            &fixture.root,
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        ))
        .await
        .unwrap();
        assert_eq!(within(connection.tools()).await.unwrap().len(), 2);
        let read = within(connection.read_resource("test://readme", None))
            .await
            .unwrap()
            .unwrap();
        assert!(read.to_string().contains("http peer text"));
        connection.close().await.unwrap();
        // Stale peer: a closed connection cannot deliver a catalog.
        assert!(connection.is_closed(), "closed peer must report closed");
        assert!(
            connection.tools().await.is_err(),
            "closed peer must not deliver a catalog"
        );
        peer.task.abort();
    }

    // Deadline: a slow stdio call exceeds the configured execution deadline; closing
    // the connection reaps the owned peer process.
    let slow_state = mcp_table_config(
        &fixture,
        "slow-peer",
        serde_json::json!({
            "capabilities": {"tools": {}},
            "responses": {"tools/list": {"": {"tools": [{"name": "slow", "inputSchema": {"type": "object"}}]}}},
            "calls": {"slow": {"delay": 5, "result": {"content": []}}}
        }),
    );
    let slow_config = ycoding_schema::mcp::ServerConfig::decode(
        &parse_json(
            &serde_json::json!({"type": "local", "timeout": {"execution": 500}, "command": ["python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"), slow_state]}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let slow = within(Connection::connect(
        "slow-peer",
        &slow_config,
        &fixture.root,
        "1.0.0",
        &BTreeMap::new(),
        Hooks::default(),
    ))
    .await
    .unwrap();
    assert_eq!(within(slow.tools()).await.unwrap().len(), 1);
    let deadline = within(slow.call_tool("slow", serde_json::json!({}), None)).await;
    assert_eq!(
        deadline.unwrap_err().to_string(),
        "MCP request timed out",
        "configured execution deadline must cut the slow call"
    );
    slow.close().await.unwrap();

    // Elicitation/Form: a real stdio peer asks for a form; the typed host
    // reply reaches the peer and its result returns to the consumer.
    let peer_script = fixture.root.join("elicitation_peer.py");
    fs::write(
        &peer_script,
        r#"import json, sys
def send(message):
    sys.stdout.write(json.dumps(message) + "\n"); sys.stdout.flush()
pending = None
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"protocolVersion": msg["params"]["protocolVersion"], "capabilities": {"tools": {}}, "serverInfo": {"name": "elicitation-peer", "version": "1"}}})
    elif msg.get("method") == "tools/list":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"tools": [{"name": "ask", "inputSchema": {"type": "object"}}]}})
    elif msg.get("method") == "tools/call":
        pending = msg["id"]
        send({"jsonrpc": "2.0", "id": "client-input", "method": "elicitation/create", "params": {"mode": "form", "message": "Who?", "requestedSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}}})
    elif msg.get("id") == "client-input":
        send({"jsonrpc": "2.0", "id": pending, "result": {"content": [], "structuredContent": msg["result"]}})
"#,
    )
    .unwrap();
    let elicitation_config = ycoding_schema::mcp::ServerConfig::decode(
        &parse_json(
            &serde_json::json!({"type": "local", "command": ["python3", peer_script]}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let elicitation = within(Connection::connect(
        "elicitation-peer",
        &elicitation_config,
        &fixture.root,
        "1.0.0",
        &BTreeMap::new(),
        Hooks {
            elicitation: Some(Arc::new(|_, _, _| {
                Box::pin(async {
                    Ok(serde_json::json!({"action": "accept", "content": {"name": "Ada"}}))
                })
            })),
            ..Hooks::default()
        },
    ))
    .await
    .unwrap();
    assert_eq!(within(elicitation.tools()).await.unwrap().len(), 1);
    let answered = within(elicitation.call_tool("ask", serde_json::json!({}), None))
        .await
        .unwrap();
    assert_eq!(
        answered.structured,
        Some(serde_json::json!({"action": "accept", "content": {"name": "Ada"}}))
    );
    elicitation.close().await.unwrap();
    fixture.cleanup();

    // Permission denial blocks the peer effect: the McpTools consumer sees
    // an error and the peer log records zero tools/call requests.
    let fixture = ToolFixture::new();
    fixture.deny("peer_act", "*");
    let state = mcp_table_config(
        &fixture,
        "peer",
        serde_json::json!({
            "capabilities": {"tools": {"listChanged": true}},
            "responses": {"tools/list": {"": {"tools": [{"name": "act", "description": "Act", "inputSchema": {"type": "object", "properties": {}}}]}}},
            "calls": {"act": {"result": {"content": [{"type": "text", "text": "acted"}]}}}
        }),
    );
    let entries = [ycoding_core::resources::config::Entry::Document {
        path: None,
        info: parse_json(
            &serde_json::json!({"mcp": {"servers": {"peer": {"type": "local", "codemode": false, "command": ["python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"), state]}}}})
                .to_string(),
        )
        .unwrap(),
    }];
    let service = Arc::new(
        ycoding_core::resources::mcp::Service::new(
            &entries,
            fixture.root.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap(),
    );
    let registry = Arc::new(fixture.registry());
    let mcp_tools = ycoding_core::tools::builtin::mcp::McpTools::start(
        service.clone(),
        registry.clone(),
        fixture.policy.clone(),
        None,
    );
    let advertised = tokio::time::timeout(WAIT, async {
        loop {
            if registry
                .materialize(&[])
                .definitions
                .iter()
                .any(|definition| definition.name.as_str() == Some("peer_act"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(
        advertised.is_ok(),
        "peer_act was not advertised before the deadline"
    );
    let denied = within(registry.materialize(&[]).invoke(
        "peer_act",
        parse_json("{}").unwrap(),
        fixture.context(),
    ))
    .await
    .unwrap();
    assert!(
        is_error(&denied),
        "denied MCP call must error: {:?}",
        denied.result
    );
    let log = fs::read_to_string(fixture.root.join("peer.log")).unwrap_or_default();
    assert_eq!(
        log.matches("\"tools/call\"").count(),
        0,
        "denial must block the peer effect: {log}"
    );
    mcp_tools.stop().await.unwrap();
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

// ---------------------------------------------------------------------------
// TEST-046 (continued): Git worktree and project copy, PTY, restart.
// ---------------------------------------------------------------------------

fn git_output(directory: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args([
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
        ])
        .args(args)
        .current_dir(directory)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test]
async fn test046_git_worktree_and_project_copy_outcomes_are_inspected() {
    use ycoding_core::platform::{project_copy, worktree};
    let world = tool_world();
    let root = world.fixture.root.clone();
    fs::write(root.join("tracked.txt"), "tracked content\n").unwrap();
    git_output(&root, &["init", "-b", "main"]);
    git_output(&root, &["add", "tracked.txt"]);
    git_output(&root, &["commit", "-m", "initial"]);
    let head = git_output(&root, &["rev-parse", "HEAD"]);

    let created = world
        .invoke(
            "worktree",
            parse_json(r#"{"action":"create","name":"flow-copy"}"#).unwrap(),
        )
        .await;
    assert!(!is_error(&created), "{}", error_text(&created));
    let git_service = Arc::new(git::Service::new(16 * 1024 * 1024));
    let repository = git_service.discover(&root).unwrap().unwrap();
    let target =
        worktree::managed_destination(&root.join("data"), &repository, "flow-copy").unwrap();
    assert!(target.is_dir(), "the created worktree directory exists");
    assert!(
        format!("{:?}", created.result).contains(&*target.to_string_lossy()),
        "the tool result names the managed destination: {:?}",
        created.result
    );
    assert_eq!(
        git_output(&target, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "flow-copy",
        "worktree is on the named branch"
    );
    assert_eq!(git_output(&target, &["rev-parse", "HEAD"]), head);
    assert_eq!(git_output(&target, &["ls-files"]), "tracked.txt");
    assert_eq!(git_output(&target, &["status", "--porcelain"]), "");
    assert_eq!(
        fs::read_to_string(target.join("tracked.txt")).unwrap(),
        "tracked content\n"
    );
    assert_eq!(
        git_output(&root, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "main",
        "creating a worktree leaves the primary checkout on its branch"
    );
    fs::write(target.join("tracked.txt"), "worktree edit\n").unwrap();
    assert_eq!(
        fs::read_to_string(root.join("tracked.txt")).unwrap(),
        "tracked content\n",
        "worktree edits stay isolated from the primary checkout"
    );
    let listed = world
        .invoke("worktree", parse_json(r#"{"action":"list"}"#).unwrap())
        .await;
    let listing = stringify_json(&listed.output.unwrap().structured);
    assert!(
        listing.contains("flow-copy") && listing.contains(&*target.to_string_lossy()),
        "{listing}"
    );
    let duplicate = world
        .invoke(
            "worktree",
            parse_json(r#"{"action":"create","name":"flow-copy"}"#).unwrap(),
        )
        .await;
    assert!(is_error(&duplicate), "duplicate branch name must reject");

    let copies = root.parent().unwrap().join(format!(
        "tool-flow-copies-{}-{}",
        std::process::id(),
        root.file_name().unwrap().to_string_lossy()
    ));
    let copy = project_copy::create(
        &git_service,
        &root,
        &copies,
        "copy-one",
        Some("copy-branch"),
    )
    .unwrap();
    assert_eq!(copy, copies.join("copy-one"));
    assert_eq!(
        git_output(&copy, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "copy-branch"
    );
    assert_eq!(git_output(&copy, &["rev-parse", "HEAD"]), head);
    assert_eq!(git_output(&copy, &["ls-files"]), "tracked.txt");
    assert_eq!(
        fs::read_to_string(copy.join("tracked.txt")).unwrap(),
        "tracked content\n"
    );
    assert!(
        project_copy::list(&git_service, &root)
            .unwrap()
            .iter()
            .any(|entry| entry.copy && entry.directory == copy),
        "the project copy is listed as a copy"
    );
    project_copy::remove(&git_service, &copy, false).unwrap();
    assert!(!copy.exists());

    world.fixture.deny("worktree", "*");
    let denied = world
        .invoke(
            "worktree",
            parse_json(r#"{"action":"create","name":"denied-copy"}"#).unwrap(),
        )
        .await;
    assert!(is_error(&denied));
    assert_eq!(
        git_output(&root, &["branch", "--list", "denied-copy"]),
        "",
        "denied worktree creation leaves no branch"
    );
    assert!(
        !worktree::managed_destination(&root.join("data"), &repository, "denied-copy")
            .unwrap()
            .exists()
    );
    fs::remove_dir_all(&copies).ok();
    world.cleanup();
}

fn pty_input(command: &str, directory: &std::path::Path) -> ycoding_schema::pty::CreateInput {
    let mut value = match parse_json(
        r#"{"sessionID":"ses_pty_flow","maxRuntimeSeconds":20,"maxRetainedBytes":1048576}"#,
    )
    .unwrap()
    {
        JsonValue::Object(value) => value,
        _ => unreachable!(),
    };
    value.insert("command".into(), JsonValue::String("/bin/sh".into()));
    value.insert(
        "args".into(),
        JsonValue::Array(vec![
            JsonValue::String("-c".into()),
            JsonValue::String(command.into()),
        ]),
    );
    value.insert(
        "cwd".into(),
        JsonValue::String(directory.to_string_lossy().as_ref().into()),
    );
    ycoding_schema::pty::CreateInput::decode(&JsonValue::Object(value)).unwrap()
}

async fn pty_until(
    attachment: &mut ycoding_core::platform::pty::Attachment,
    needle: &str,
) -> String {
    use ycoding_core::platform::pty::Delivery;
    within(async {
        let mut text = String::from_utf8_lossy(&attachment.replay.data).into_owned();
        while !text.contains(needle) {
            let Delivery::Chunk(chunk) = attachment.recv().await.unwrap() else {
                panic!("terminal ended before {needle:?}: {text:?}")
            };
            text.push_str(&String::from_utf8_lossy(&chunk.data));
        }
        text
    })
    .await
}

#[tokio::test]
async fn test046_pty_input_resize_output_status_disconnect_cancel_and_shutdown() {
    use ycoding_core::platform::{
        process,
        pty::{
            Pty,
            ticket::{Scope, Tickets},
        },
    };
    use ycoding_schema::{
        pty::{self, Access, Actor, Size},
        schema::PositiveInt,
        session_id::SessionId,
    };
    let fixture = ToolFixture::new();
    let root = fixture.root.clone();
    let pty = Pty::new(root.clone());
    let owner = SessionId::new("ses_pty_flow").unwrap();

    // Input -> output -> consumer with an exact exit status.
    let info = pty
        .create(
            pty_input(
                "pwd -P; printf READY; read x; stty size; printf '\\nVALUE:%s\\n' \"$x\"; exit 7",
                &root,
            ),
            None,
        )
        .await
        .unwrap();
    assert!(
        pty.get(&info.id, &SessionId::new("ses_other").unwrap())
            .is_err(),
        "another Session cannot see the terminal"
    );
    let pid = info.pid.get() as u32;
    assert!(process::is_alive(pid).unwrap());
    let mut first = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    first.activate();
    let text = pty_until(&mut first, "READY").await;
    assert!(
        text.contains(&*root.to_string_lossy()),
        "terminal starts in the requested cwd: {text:?}"
    );
    drop(first);
    assert!(
        process::is_alive(pid).unwrap(),
        "disconnecting a viewer must not end the terminal"
    );
    let mut second = pty
        .attach(&info.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    second.activate();
    assert!(
        pty_until(&mut second, "READY").await.contains("READY"),
        "reattach replays retained output"
    );
    pty.update(
        &info.id,
        pty::UpdateInput {
            session_id: owner.clone(),
            generation: PositiveInt::new(1).unwrap(),
            expected_fence: PositiveInt::new(1).unwrap(),
            actor: Actor::Agent,
            title: None,
            size: Some(Size {
                rows: PositiveInt::new(31).unwrap(),
                cols: PositiveInt::new(97).unwrap(),
            }),
        },
    )
    .await
    .unwrap();
    pty.write(&info.id, &owner, 1, 1, Actor::Agent, "input\n")
        .await
        .unwrap();
    let text = pty_until(&mut second, "VALUE:input").await;
    assert!(
        text.contains("31 97"),
        "resize reached the terminal: {text:?}"
    );
    let settled = within(pty.wait(&info.id, &owner)).await.unwrap();
    assert_eq!(settled.status, pty::Status::Exited);
    assert_eq!(settled.exit_code.unwrap().get(), 7);
    assert!(!process::is_alive(pid).unwrap());
    pty.remove(&info.id, &owner).await.unwrap();

    // Attach tickets are one-use and bound to the terminal, owner and fence.
    let scope = Scope {
        pty_id: info.id.clone(),
        session_id: owner.clone(),
        access: Access::Control,
        generation: 1,
        fence: Some(1),
        directory: Some(root.to_string_lossy().as_ref().into()),
        workspace_id: None,
    };
    let mut tickets = Tickets::new(WAIT);
    let ticket = tickets
        .issue(scope.clone())
        .unwrap()
        .ticket
        .to_utf8()
        .unwrap();
    let mut foreign = scope.clone();
    foreign.session_id = SessionId::new("ses_other").unwrap();
    assert!(!tickets.consume(&ticket, &foreign));
    assert!(tickets.consume(&ticket, &scope));
    assert!(!tickets.consume(&ticket, &scope));

    // Cancellation: removing a running terminal ends its process.
    let running = pty
        .create(
            pty_input("printf READY; exec tail -f /dev/null", &root),
            None,
        )
        .await
        .unwrap();
    let running_pid = running.pid.get() as u32;
    let mut attachment = pty
        .attach(&running.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    attachment.activate();
    pty_until(&mut attachment, "READY").await;
    assert!(process::is_alive(running_pid).unwrap());
    pty.remove(&running.id, &owner).await.unwrap();
    assert!(!process::is_alive(running_pid).unwrap());
    assert!(pty.get(&running.id, &owner).is_err());

    // Shutdown (host restart) ends every owned terminal.
    let survivor = pty
        .create(
            pty_input("printf READY; exec tail -f /dev/null", &root),
            None,
        )
        .await
        .unwrap();
    let survivor_pid = survivor.pid.get() as u32;
    let mut watcher = pty
        .attach(&survivor.id, &owner, Some(1), 0, Access::Inspect, None)
        .unwrap();
    watcher.activate();
    pty_until(&mut watcher, "READY").await;
    pty.shutdown().await.unwrap();
    assert!(!process::is_alive(survivor_pid).unwrap());
    fixture.cleanup();
}

struct OrphanTree {
    child: tokio::process::Child,
    pid: u32,
    lines: tokio::io::BufReader<tokio::process::ChildStdout>,
}

impl OrphanTree {
    async fn new(script: &str) -> Self {
        use tokio::io::AsyncBufReadExt;
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        within(lines.read_line(&mut ready)).await.unwrap();
        assert_eq!(ready, "READY\n");
        Self { child, pid, lines }
    }
}

impl Drop for OrphanTree {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.pid as i32), libc::SIGKILL);
        }
    }
}

#[tokio::test]
async fn test046_restart_reconciles_orphaned_shell_trees_and_retains_the_lost_notice() {
    use std::os::unix::process::ExitStatusExt;
    use tokio::io::AsyncBufReadExt;
    use ycoding_core::platform::{
        process,
        shell::ledger::{self, Ledger, Process},
    };
    use ycoding_schema::{LosslessString, shell::Id};
    use ycoding_store::{KeyPart, resources::ShellTable, tuple_key};
    let fixture = ToolFixture::new();
    let path = fixture.root.join("core.redb");
    let catalog = ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core);
    let metadata = ycoding_store::Metadata::new([31; 16], 1);
    let store =
        ycoding_store::Store::initialize(&path, ycoding_store::Options::core(), catalog, metadata)
            .unwrap();
    store
        .submit(|tx| {
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
            ycoding_store::session::SessionTable::insert(tx, &support::record("ses_notice"))
        })
        .unwrap()
        .wait()
        .unwrap();
    let dead_owner = Process {
        pid: 2_000_000_000,
        pgid: 2_000_000_000,
        started: "Thu Jan 1 00:00:00 1970".into(),
    };
    let shell_id = |name: &str| Id::decode(&JsonValue::String(name.into())).unwrap();
    let tree_id = shell_id("sh_restart_tree");
    let reused_id = shell_id("sh_restart_reused");

    // Previous Core: one running job tree owes a completion notice; another
    // ledger row's PID now belongs to an unrelated live process.
    let mut tree = OrphanTree::new("tail -f /dev/null & printf 'READY\\n'; echo $!; wait").await;
    let mut descendant = String::new();
    within(tree.lines.read_line(&mut descendant)).await.unwrap();
    let descendant: u32 = descendant.trim().parse().unwrap();
    let bystander = OrphanTree::new("printf 'READY\\n'; exec tail -f /dev/null").await;
    let ledger = Ledger::new(store.client());
    ledger
        .record(
            &tree_id,
            tree.pid,
            ledger::identify(tree.pid)
                .await
                .map(|identity| identity.started),
            &dead_owner,
        )
        .await
        .unwrap();
    ledger
        .notice_owed(
            &tree_id,
            ycoding_schema::session_id::SessionId::new("ses_notice").unwrap(),
        )
        .await
        .unwrap();
    ledger
        .record(
            &reused_id,
            bystander.pid,
            Some("wrong birth identity".into()),
            &dead_owner,
        )
        .await
        .unwrap();
    drop(ledger);
    store.shutdown().unwrap();

    // New Core over the same file-backed store and project.
    let store = ycoding_store::Store::open(&path, ycoding_store::Options::core(), catalog).unwrap();
    let ledger = Ledger::new(store.client());
    let row = |store: &ycoding_store::Store, name: &str| {
        store
            .client()
            .snapshot()
            .unwrap()
            .get::<ShellTable>(&tuple_key(&[KeyPart::String(&LosslessString::from(name))]))
            .unwrap()
    };
    assert!(process::is_alive(tree.pid).unwrap() && process::is_alive(descendant).unwrap());
    assert!(row(&store, "sh_restart_tree").unwrap().time_lost.is_none());
    let (report, status) = tokio::join!(
        ledger.reconcile(Duration::from_millis(100)),
        tree.child.wait()
    );
    let report = report.unwrap();
    assert!(!report.process_list_unavailable);
    assert!(
        report.signal_failures.is_empty(),
        "{:?}",
        report.signal_failures
    );
    assert_eq!(status.unwrap().signal(), Some(libc::SIGTERM));
    within(async {
        while process::is_alive(descendant).unwrap() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert!(
        row(&store, "sh_restart_tree").unwrap().time_lost.is_some(),
        "the owed notice is retained as lost"
    );
    assert_eq!(
        ledger.lost_sessions().unwrap(),
        vec![LosslessString::from("ses_notice")]
    );
    assert!(
        process::is_alive(bystander.pid).unwrap(),
        "a PID whose identity differs from the ledger is never signalled"
    );
    assert!(
        row(&store, "sh_restart_reused").is_none(),
        "the unverifiable row is retired after inspection"
    );

    // A second restart keeps the unacknowledged lost notice until admitted.
    drop(ledger);
    store.shutdown().unwrap();
    let store = ycoding_store::Store::open(&path, ycoding_store::Options::core(), catalog).unwrap();
    let ledger = Ledger::new(store.client());
    ledger.reconcile(Duration::ZERO).await.unwrap();
    assert_eq!(
        ledger.lost_sessions().unwrap(),
        vec![LosslessString::from("ses_notice")]
    );
    ledger.notice_admitted(&tree_id).await.unwrap();
    assert!(row(&store, "sh_restart_tree").is_none());
    assert!(ledger.lost_sessions().unwrap().is_empty());
    drop(ledger);
    drop(bystander);
    store.shutdown().unwrap();
    fixture.cleanup();
}

// ---------------------------------------------------------------------------
// TEST-048 (continued): killed peer, reconnect and skill traversal.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test048_killed_stdio_peer_is_stale_fails_closed_and_reconnects_on_a_fresh_process() {
    use ycoding_core::{
        platform::process,
        resources::mcp::client::{Connection, Hooks},
    };
    let fixture = ToolFixture::new();
    let state = mcp_table_config(
        &fixture,
        "kill-peer",
        serde_json::json!({
            "capabilities": {"tools": {}},
            "responses": {"tools/list": {"": {"tools": [{"name": "first", "inputSchema": {"type": "object"}}]}}},
            "calls": {"first": {"result": {"content": [{"type": "text", "text": "called"}]}}}
        }),
    );
    let config = ycoding_schema::mcp::ServerConfig::decode(
        &parse_json(
            &serde_json::json!({"type": "local", "command": ["python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"), state]}).to_string(),
        )
        .unwrap(),
    )
    .unwrap();
    let environment = BTreeMap::new();
    let connect = || {
        Connection::connect(
            "kill-peer",
            &config,
            &fixture.root,
            "1.0.0",
            &environment,
            Hooks::default(),
        )
    };
    let connection = within(connect()).await.unwrap();
    let pid = connection.process_id().unwrap();
    assert!(process::is_alive(pid).unwrap());
    assert!(
        !within(connection.call_tool("first", serde_json::json!({}), None))
            .await
            .unwrap()
            .is_error
    );

    assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
    within(async {
        while !connection.is_closed() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(
        within(connection.call_tool("first", serde_json::json!({}), None))
            .await
            .is_err(),
        "a killed peer cannot deliver a call result"
    );
    assert!(within(connection.tools()).await.is_err());
    connection.close().await.unwrap();
    within(async {
        while process::is_alive(pid).unwrap() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;

    let fresh = within(connect()).await.unwrap();
    assert_ne!(
        fresh.process_id().unwrap(),
        pid,
        "reconnect starts a new peer"
    );
    assert_eq!(within(fresh.tools()).await.unwrap().len(), 1);
    assert!(
        !within(fresh.call_tool("first", serde_json::json!({}), None))
            .await
            .unwrap()
            .is_error
    );
    fresh.close().await.unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn test048_service_disconnect_and_killed_peer_fail_the_held_tool_until_reconnect() {
    use ycoding_core::resources::mcp::client::Hooks;
    let fixture = ToolFixture::new();
    let state = mcp_table_config(
        &fixture,
        "svc-peer",
        serde_json::json!({
            "capabilities": {"tools": {"listChanged": true}},
            "responses": {"tools/list": {"": {"tools": [{"name": "act", "description": "Act", "inputSchema": {"type": "object", "properties": {}}}]}}},
            "calls": {"act": {"result": {"content": [{"type": "text", "text": "acted"}]}}}
        }),
    );
    let entries = [ycoding_core::resources::config::Entry::Document {
        path: None,
        info: parse_json(
            &serde_json::json!({"mcp": {"servers": {"svc": {"type": "local", "codemode": false, "command": ["python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"), state]}}}})
                .to_string(),
        )
        .unwrap(),
    }];
    let service = Arc::new(
        ycoding_core::resources::mcp::Service::new(
            &entries,
            fixture.root.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap(),
    );
    let registry = Arc::new(fixture.registry());
    let mcp_tools = ycoding_core::tools::builtin::mcp::McpTools::start(
        service.clone(),
        registry.clone(),
        fixture.policy.clone(),
        None,
    );
    let call = || async {
        within(registry.materialize(&[]).invoke(
            "svc_act",
            parse_json("{}").unwrap(),
            fixture.context(),
        ))
        .await
        .unwrap()
    };
    let advertised = |registry: Arc<Registry>| async move {
        within(async {
            while !registry
                .materialize(&[])
                .definitions
                .iter()
                .any(|definition| definition.name.as_str() == Some("svc_act"))
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
    };
    advertised(registry.clone()).await;
    let live = call().await;
    assert!(!is_error(&live), "{live:?}");

    within(service.disconnect("svc")).await.unwrap();
    let held = call().await;
    assert!(
        is_error(&held),
        "a disconnected peer cannot deliver through a held tool: {held:?}"
    );

    within(service.connect("svc")).await.unwrap();
    advertised(registry.clone()).await;
    let reconnected = call().await;
    assert!(!is_error(&reconnected), "{reconnected:?}");
    let log = fs::read_to_string(fixture.root.join("svc-peer.log")).unwrap();
    assert_eq!(
        log.matches("\"initialize\"").count(),
        2,
        "reconnect initializes a fresh peer process: {log}"
    );
    assert_eq!(log.matches("\"tools/call\"").count(), 2);

    let killed = Command::new("pkill")
        .args(["-9", "-f", &state_pattern(&fixture, "svc-peer")])
        .status()
        .unwrap();
    assert!(killed.success(), "the real peer process was killed");
    let stale = call().await;
    assert!(
        is_error(&stale),
        "a killed peer cannot deliver a stale success: {stale:?}"
    );
    mcp_tools.stop().await.unwrap();
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

fn state_pattern(fixture: &ToolFixture, name: &str) -> String {
    fixture
        .root
        .join(format!("{name}.json"))
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn test048_skill_resource_traversal_and_stale_origin_reject_before_any_peer_fetch() {
    use ycoding_core::resources::mcp::client::{Connection, Error, Hooks};
    use ycoding_schema::mcp_skill::Reason;
    let fixture = ToolFixture::new();
    for sse in [false, true] {
        let peer = HttpPeer::new(sse).await;
        let connection = within(Connection::connect(
            "skills-peer",
            &peer.config(Some("good")),
            &fixture.root,
            "1.0.0",
            &BTreeMap::new(),
            Hooks::default(),
        ))
        .await
        .unwrap();
        let entries = within(connection.skill_entries()).await.unwrap();
        assert_eq!(entries.len(), 1);
        let reads = || peer.reads.load(std::sync::atomic::Ordering::SeqCst);
        for uri in [
            "skill://a/../b/SKILL.md",
            "skill://a/%2e%2e/b/SKILL.md",
            "skill://a/references/%2fsecret",
            "skill://a/references/../../SKILL.md",
            "skill://b/SKILL.md",
            "skill://a/SKILL.md?x=1",
            "file:///etc/passwd",
            "/etc/passwd",
        ] {
            assert_eq!(
                connection.read_skill_resource(&entries[0], uri).await,
                Err(Error::Skill(Reason::UnlistedResource)),
                "{uri}"
            );
        }
        assert_eq!(reads(), 0, "traversal rejects before any peer fetch");

        let mut stale = entries[0].clone();
        stale.server = "other".into();
        assert_eq!(
            connection
                .read_skill_resource(&stale, "skill://a/SKILL.md")
                .await,
            Err(Error::Skill(Reason::OriginMismatch)),
            "an entry owned by another server is rejected"
        );
        assert_eq!(reads(), 0);

        assert_eq!(
            connection.skill_entry("skill://evil/SKILL.md").await,
            Err(Error::Skill(Reason::ResourceOutsideSkill)),
            "a peer manifest that escapes its skill root is rejected on decode"
        );
        assert_eq!(reads(), 0);

        for uri in ["skill://a/SKILL.md", "skill://a/references/GUIDE.md"] {
            assert!(
                connection
                    .read_skill_resource(&entries[0], uri)
                    .await
                    .is_ok(),
                "{uri}"
            );
        }
        assert_eq!(reads(), 2, "only listed resources reach the peer");
        connection.close().await.unwrap();
        peer.task.abort();
    }
    fixture.cleanup();
}
