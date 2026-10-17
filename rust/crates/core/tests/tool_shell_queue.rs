#![cfg(unix)]
include!("tool_fixture.rs");
mod shell_queue_support;

use shell_queue_support::{Host, Temp};
use std::{
    ops::Bound,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_ai::llm::ToolOutput;
use ycoding_core::{
    platform::shell::{Shell, queue::Queue},
    resources::config::{Configuration, LoadOptions, Roots},
    tools::{
        builtin::shell::{AUTO_BACKGROUND, Job, Jobs, Lease, Notice, NoticeFuture, ShellTool},
        context::Context,
        registry::{Failure, Options, Tool},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, llm::ToolContent, parse_json, session_id::SessionId,
    shell::Status, stringify_json,
};
use ycoding_store::resources::ShellTable;

const QUEUED_INSTRUCTION: &str = "It starts when the queue admits it, and its timeout counts from that start. You will be notified automatically when the command finishes. DO NOT sleep, poll, or proactively check on its progress.";

struct Counted(Arc<AtomicUsize>);
impl Drop for Counted {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Recorder {
    notices: Mutex<Vec<Notice>>,
    leases: Arc<AtomicUsize>,
    background: Mutex<Vec<Job>>,
}
impl Recorder {
    fn lease(&self) -> Lease {
        self.leases.fetch_add(1, Ordering::SeqCst);
        Box::new(Counted(self.leases.clone()))
    }
}
impl Jobs for Recorder {
    fn foreground(&self, _job: &Job, _background: Arc<Notify>) -> Lease {
        self.lease()
    }
    fn background(&self, job: &Job) -> Lease {
        self.background.lock().unwrap().push(job.clone());
        self.lease()
    }
    fn deliver(&self, notice: Notice) -> NoticeFuture {
        self.notices.lock().unwrap().push(notice);
        Box::pin(async { Ok(()) })
    }
}

struct Harness {
    fixture: ToolFixture,
    store: ycoding_store::Store,
    shell: Arc<Shell>,
    jobs: Arc<Recorder>,
    tool: Arc<ShellTool>,
    _queue_dir: Temp,
}
impl Harness {
    async fn new(queue_config: &str) -> Self {
        Self::with(ToolFixture::new(), queue_config).await
    }
    async fn with(fixture: ToolFixture, queue_config: &str) -> Self {
        fixture.authority.session("ses_tool", None, 0, false, None);
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([33; 16], 1),
        )
        .unwrap();
        let roots = Roots::development(&fixture.root).unwrap();
        let configuration = Arc::new(
            Configuration::load(LoadOptions {
                directory: fixture.root.clone(),
                roots: roots.clone(),
                project: false,
                content: Some(format!(
                    r#"{{"shell":"/bin/sh","shell_queue":{queue_config}}}"#
                )),
                file: None,
                env: Default::default(),
            })
            .unwrap(),
        );
        let queue_dir = Temp::new("tool-shell-queue");
        let queue = Queue::open(Host::new(1_000_000.0, 0.0).options(queue_dir.path()))
            .await
            .unwrap();
        let shell = Arc::new(
            Shell::new(&roots, fixture.root.clone(), "project", store.client())
                .await
                .unwrap()
                .with_queue(queue),
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
            jobs,
            tool,
            _queue_dir: queue_dir,
        }
    }
    fn context(&self, call: &str) -> Context {
        Context::new("ses_tool", "test", "msg_tool", call).unwrap()
    }
    async fn call(&self, call: &str, input: serde_json::Value) -> Result<ToolOutput, Failure> {
        tokio::time::timeout(
            Duration::from_secs(30),
            self.tool
                .settle(parse_json(&input.to_string()).unwrap(), self.context(call)),
        )
        .await
        .expect("shell tool call exceeds 30 seconds")
    }
    async fn queued(&self, call: &str, command: &str) -> ToolOutput {
        self.call(
            call,
            serde_json::json!({"command": command, "channel": "queue"}),
        )
        .await
        .unwrap()
    }
    async fn status(&self, id: &str) -> Status {
        let id = ycoding_schema::shell::Id::decode(&JsonValue::String(id.into())).unwrap();
        self.shell.get(&id).await.unwrap().status
    }
    async fn running(&self, id: &str) {
        until(|| (self.try_status(id) == Some(Status::Running)).then_some(())).await;
    }
    fn try_status(&self, id: &str) -> Option<Status> {
        self.shell
            .list()
            .into_iter()
            .find(|info| info.id.encode() == JsonValue::String(id.into()))
            .map(|info| info.status)
    }
    fn rows(&self) -> usize {
        self.store
            .client()
            .snapshot()
            .unwrap()
            .scan::<ShellTable>(Bound::Unbounded, Bound::Unbounded, 64)
            .unwrap()
            .len()
    }
    async fn finish(self) {
        for info in self.shell.list() {
            let _ = self.shell.remove(&info.id).await;
        }
        self.shell.shutdown().await.unwrap();
        drop(self.tool);
        drop(self.shell);
        self.store.shutdown().unwrap();
        self.fixture.cleanup();
    }
}

fn texts(output: &ToolOutput) -> Vec<String> {
    output
        .content
        .iter()
        .map(|item| match item {
            ToolContent::Text(text) => text.text.to_utf8().unwrap(),
            ToolContent::File(_) => panic!("unexpected file content"),
        })
        .collect()
}
fn structured(output: &ToolOutput) -> serde_json::Value {
    serde_json::from_str(&stringify_json(&output.structured)).unwrap()
}
fn shell_id(output: &ToolOutput) -> String {
    let id = structured(output)["shellID"].as_str().unwrap().to_owned();
    assert!(id.starts_with("sh_"));
    id
}
fn failure(result: Result<ToolOutput, Failure>) -> String {
    match result {
        Err(Failure::Tool { message, .. }) => message,
        other => panic!("expected a tool failure, got {other:?}"),
    }
}
fn release_loop(release: &Path, then: &str) -> String {
    format!(
        "while [ ! -e '{}' ]; do sleep 0.05; done; {then}",
        release.display()
    )
}
async fn until<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    for _ in 0..1000 {
        if let Some(value) = probe() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("condition not reached within 10 seconds")
}
fn completed(notices: &[Notice], shell: &str) -> Option<(&'static str, String, bool)> {
    notices.iter().find_map(|notice| match notice {
        Notice::Completed {
            shell_id,
            state,
            text,
            resume,
            ..
        } if shell_id == shell => Some((*state, text.clone(), *resume)),
        _ => None,
    })
}
fn session() -> SessionId {
    SessionId::decode(&JsonValue::String("ses_tool".into())).unwrap()
}

#[tokio::test]
async fn the_definition_documents_the_queue_channel_and_accepts_only_the_declared_channels() {
    let harness = Harness::new("{}").await;
    let registry = harness.fixture.registry();
    let _registration = registry
        .register(
            vec![("shell".into(), harness.tool.clone() as Arc<dyn Tool>)],
            Options::direct(),
        )
        .unwrap();
    let definition = &registry.materialize(&[]).definitions[0];
    let description = definition.description.to_utf8().unwrap();
    for sentence in [
        "channel=queue returns immediately with its shell ID and machine-wide queue position",
        "Guardrail review runs at submission, but waiting commands hold no family shell slot; admission reserves family capacity before claiming queue running slots",
        "With no queued command running, the ordered head may claim run-0 regardless of resource headroom, within family and per-Session caps and turn order",
        "A memory requirement is the highest peak of the last five recorded queued runs for the exact command and resolved working directory, capped by memory_limit_mb",
        "History retains up to 256 keys across local processes, with background writes after completion and slot release",
        "Its timeout counts from start, and completion is delivered automatically like a background command",
        "Use channel=queue for typechecks, builds, and package-wide test suites; use the default channel=normal for ordinary commands.",
    ] {
        assert!(description.contains(sentence), "{sentence}");
    }
    let input =
        serde_json::from_str::<serde_json::Value>(&stringify_json(&definition.input_schema))
            .unwrap();
    assert_eq!(
        input["properties"]["channel"]["enum"],
        serde_json::json!(["normal", "queue"])
    );
    assert!(
        input["properties"]["channel"]["description"]
            .as_str()
            .unwrap()
            .starts_with("normal (default) runs the command now. queue returns immediately with a bounded machine-wide queue position;")
    );
    assert_eq!(input["required"], serde_json::json!(["command"]));
    for channel in ["normal", "queue"] {
        harness
            .call(
                "call_channel",
                serde_json::json!({"command": "true", "channel": channel}),
            )
            .await
            .unwrap();
    }
    assert_eq!(
        failure(
            harness
                .call(
                    "call_bad",
                    serde_json::json!({"command": "true", "channel": "background"})
                )
                .await
        ),
        "Invalid tool input: Invalid channel"
    );
    harness.finish().await;
}

#[tokio::test]
async fn a_queue_channel_command_returns_at_once_as_queued_and_delivers_its_completion_automatically()
 {
    let harness = Harness::new(r#"{"max_running":1}"#).await;
    let release = harness.fixture.root.join("release");
    let first = harness
        .queued("call_first", &release_loop(&release, "printf first-done"))
        .await;
    let first_id = shell_id(&first);
    assert_eq!(
        structured(&first),
        serde_json::json!({"shellID": first_id, "truncated": false})
    );
    assert_eq!(
        texts(&first),
        [
            "The command was added to the machine-wide shell queue at position 1.",
            QUEUED_INSTRUCTION
        ]
    );
    harness.running(&first_id).await;
    let second = harness.queued("call_second", "printf second-done").await;
    let second_id = shell_id(&second);
    assert_eq!(
        texts(&second)[0],
        "The command was added to the machine-wide shell queue at position 1."
    );
    assert_eq!(harness.status(&second_id).await, Status::Queued);
    assert_eq!(harness.jobs.background.lock().unwrap().len(), 2);
    assert_eq!(harness.jobs.leases.load(Ordering::SeqCst), 2);
    assert_eq!(harness.rows(), 2);
    std::fs::write(&release, "").unwrap();
    let (state, text, resume) =
        until(|| completed(&harness.jobs.notices.lock().unwrap(), &first_id)).await;
    assert_eq!(
        (state, text.as_str(), resume),
        ("completed", "first-done", true)
    );
    let (state, text, resume) =
        until(|| completed(&harness.jobs.notices.lock().unwrap(), &second_id)).await;
    assert_eq!(
        (state, text.as_str(), resume),
        ("completed", "second-done", true)
    );
    until(|| {
        (harness.rows() == 0 && harness.jobs.leases.load(Ordering::SeqCst) == 0).then_some(())
    })
    .await;
    harness.finish().await;
}

#[tokio::test]
async fn a_queued_command_stopped_before_it_starts_settles_as_cancelled_and_one_beyond_the_waiting_limit_is_rejected()
 {
    let harness = Harness::new(r#"{"max_running":1,"max_queued_per_session":1}"#).await;
    let holder = shell_id(&harness.queued("call_holder", "sleep 30").await);
    harness.running(&holder).await;
    let waiting = shell_id(&harness.queued("call_waiting", "printf never").await);
    assert_eq!(harness.status(&waiting).await, Status::Queued);
    let rejected = failure(
        harness
            .call(
                "call_rejected",
                serde_json::json!({"command": "printf rejected", "channel": "queue"}),
            )
            .await,
    );
    assert!(
        rejected.contains("already holds 1 waiting commands for this Session"),
        "{rejected}"
    );
    assert_eq!(harness.jobs.leases.load(Ordering::SeqCst), 2);
    assert_eq!(harness.rows(), 2);
    let waiting_id =
        ycoding_schema::shell::Id::decode(&JsonValue::String(waiting.as_str().into())).unwrap();
    harness.shell.remove(&waiting_id).await.unwrap();
    let (state, text, resume) =
        until(|| completed(&harness.jobs.notices.lock().unwrap(), &waiting)).await;
    assert_eq!(
        (state, text.as_str(), resume),
        ("cancelled", "Command cancelled", true)
    );
    harness.finish().await;
}

#[tokio::test]
async fn a_session_interruption_or_deletion_cancels_its_queued_commands_without_waking_it() {
    let harness = Harness::new(r#"{"max_running":1}"#).await;
    let marker = harness.fixture.root.join("interrupted-must-not-run");
    let holder = shell_id(&harness.queued("call_holder", "sleep 30").await);
    harness.running(&holder).await;
    let waiting = shell_id(
        &harness
            .queued("call_waiting", &format!("touch '{}'", marker.display()))
            .await,
    );
    assert_eq!(harness.status(&waiting).await, Status::Queued);
    assert_eq!(harness.tool.cancel_queued(&session()).await.unwrap(), 1);
    let (state, text, resume) =
        until(|| completed(&harness.jobs.notices.lock().unwrap(), &waiting)).await;
    assert_eq!(
        (state, text.as_str(), resume),
        ("cancelled", "Command cancelled", false)
    );
    assert_eq!(harness.try_status(&holder), Some(Status::Running));
    assert!(harness.try_status(&waiting).is_none());
    assert_eq!(harness.tool.cancel_queued(&session()).await.unwrap(), 0);
    until(|| (harness.rows() == 1).then_some(())).await;
    let holder_id =
        ycoding_schema::shell::Id::decode(&JsonValue::String(holder.as_str().into())).unwrap();
    harness.shell.remove(&holder_id).await.unwrap();
    let (state, _, resume) =
        until(|| completed(&harness.jobs.notices.lock().unwrap(), &holder)).await;
    assert_eq!((state, resume), ("cancelled", true));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!marker.exists());
    harness.finish().await;
}

#[tokio::test]
async fn twelve_waiting_commands_stay_outside_the_family_shell_cap_while_normal_shells_run() {
    let fixture =
        ToolFixture::new().with_guardrail_limits(ycoding_core::process::guardrails::Limits {
            shells: 4,
            shell_wait: Duration::from_secs(1),
            ..Default::default()
        });
    let harness = Harness::with(fixture, r#"{"max_running":1,"max_queued_per_session":16}"#).await;
    let holder = shell_id(&harness.queued("call_holder", "sleep 30").await);
    harness.running(&holder).await;
    harness
        .call(
            "call_normal",
            serde_json::json!({"command": "sleep 30", "background": true}),
        )
        .await
        .unwrap();
    for index in 0..12 {
        let waiting = tokio::time::timeout(
            Duration::from_secs(2),
            harness.queued(&format!("call_waiting_{index}"), "printf hello"),
        )
        .await
        .expect("a waiting queue command waited for the family cap");
        assert!(shell_id(&waiting).starts_with("sh_"));
    }
    let status = harness
        .fixture
        .policy
        .guardrails
        .status(&session())
        .unwrap();
    let shells = status
        .counters
        .iter()
        .find(|counter| counter.id.as_str() == Some("shells"))
        .unwrap();
    assert_eq!(shells.current.get(), 2);
    let normal = harness
        .call(
            "call_available_normal",
            serde_json::json!({"command": "printf hello"}),
        )
        .await
        .unwrap();
    assert_eq!(texts(&normal)[0], "hello");
    harness.finish().await;
}

#[tokio::test]
async fn a_queued_command_waits_for_family_capacity_without_holding_a_running_slot_and_starts_when_it_frees()
 {
    let fixture =
        ToolFixture::new().with_guardrail_limits(ycoding_core::process::guardrails::Limits {
            shells: 1,
            shell_wait: Duration::from_secs(1),
            ..Default::default()
        });
    let harness = Harness::with(fixture, r#"{"max_running":1}"#).await;
    let normal = shell_id(
        &harness
            .call(
                "call_full_normal",
                serde_json::json!({"command": "sleep 30", "background": true}),
            )
            .await
            .unwrap(),
    );
    let waiting = shell_id(
        &tokio::time::timeout(
            Duration::from_secs(2),
            harness.queued("call_full_queued", "printf hello"),
        )
        .await
        .expect("the queue command waited for the full family"),
    );
    let mut prepared = harness
        .shell
        .prepare(
            ycoding_schema::shell::CreateInput::decode(
                &parse_json(r#"{"command":"sleep 30","timeout":0}"#).unwrap(),
            )
            .unwrap(),
            &harness.tool.configuration,
        )
        .unwrap();
    let other = harness
        .shell
        .enqueue(&mut prepared, "ses_other_family", None)
        .await
        .unwrap();
    until(|| {
        harness
            .shell
            .list()
            .iter()
            .any(|info| info.id == other.id && info.status == Status::Running)
            .then_some(())
    })
    .await;
    assert_eq!(harness.status(&waiting).await, Status::Queued);
    harness.shell.remove(&other.id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(harness.status(&waiting).await, Status::Queued);
    let normal_id =
        ycoding_schema::shell::Id::decode(&JsonValue::String(normal.as_str().into())).unwrap();
    harness.shell.remove(&normal_id).await.unwrap();
    let (state, text, _) =
        until(|| completed(&harness.jobs.notices.lock().unwrap(), &waiting)).await;
    assert_eq!((state, text.as_str()), ("completed", "hello"));
    harness.finish().await;
}
