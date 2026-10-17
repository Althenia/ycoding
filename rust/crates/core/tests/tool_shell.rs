#![cfg(unix)]
include!("tool_fixture.rs");

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
    platform::shell::Shell,
    resources::config::{Configuration, LoadOptions, Roots},
    tools::{
        builtin::shell::{
            AUTO_BACKGROUND, Job, Jobs, Lease, MAX_CAPTURE_BYTES, Notice, NoticeFuture, ShellTool,
        },
        context::Progress,
        registry::{Failure, Options, Tool},
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, guardrail, llm::ToolContent, parse_json, permission,
    stringify_json,
};
use ycoding_store::resources::ShellTable;

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
    foreground: Mutex<Vec<(Job, Arc<Notify>)>>,
    background: Mutex<Vec<Job>>,
}
impl Recorder {
    fn lease(&self) -> Lease {
        self.leases.fetch_add(1, Ordering::SeqCst);
        Box::new(Counted(self.leases.clone()))
    }
}
impl Jobs for Recorder {
    fn foreground(&self, job: &Job, background: Arc<Notify>) -> Lease {
        self.foreground
            .lock()
            .unwrap()
            .push((job.clone(), background));
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
}
impl Harness {
    async fn new(config: &str, auto_background: Duration) -> Self {
        Self::with(ToolFixture::new(), config, auto_background).await
    }
    async fn with(fixture: ToolFixture, config: &str, auto_background: Duration) -> Self {
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
                content: Some(config.into()),
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
            auto_background,
        });
        Self {
            fixture,
            store,
            shell,
            jobs,
            tool,
        }
    }
    async fn plain() -> Self {
        Self::new("{\"shell\":\"/bin/sh\"}", AUTO_BACKGROUND).await
    }
    async fn call(&self, input: serde_json::Value) -> Result<ToolOutput, Failure> {
        tokio::time::timeout(
            Duration::from_secs(30),
            self.tool.settle(
                parse_json(&input.to_string()).unwrap(),
                self.fixture.context(),
            ),
        )
        .await
        .expect("shell tool call exceeds 30 seconds")
    }
    async fn finish(self) {
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
fn failure(result: Result<ToolOutput, Failure>) -> String {
    match result {
        Err(Failure::Tool { message, .. }) => message,
        other => panic!("expected a tool failure, got {other:?}"),
    }
}
fn shell_id(output: &ToolOutput) -> String {
    let id = structured(output)["shellID"].as_str().unwrap().to_owned();
    assert!(id.starts_with("sh_"));
    id
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
async fn asked(
    fixture: &ToolFixture,
    type_: &str,
    index: usize,
) -> ycoding_core::tools::policy::Event {
    until(|| {
        fixture
            .authority
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.type_ == type_)
            .nth(index)
            .cloned()
    })
    .await
}
fn rule(fixture: &ToolFixture, action: &str, resource: &str, effect: &str) {
    fixture
        .authority
        .rules
        .lock()
        .unwrap()
        .push(permission::Rule {
            action: action.into(),
            resource: resource.into(),
            effect: permission::Effect(effect.into()),
        });
}
fn completed(notices: &[Notice]) -> Option<(Job, String, &'static str, String)> {
    notices.iter().find_map(|notice| match notice {
        Notice::Completed {
            job,
            shell_id,
            state,
            text,
            ..
        } => Some((job.clone(), shell_id.clone(), *state, text.clone())),
        Notice::Steer { .. } => None,
    })
}

#[tokio::test]
async fn definition_input_bounds_and_registry_visibility() {
    let harness = Harness::plain().await;
    let registry = harness.fixture.registry();
    let _registration = registry
        .register(
            vec![("shell".into(), harness.tool.clone() as Arc<dyn Tool>)],
            Options::direct(),
        )
        .unwrap();
    let materialized = registry.materialize(&[]);
    let definition = &materialized.definitions[0];
    assert_eq!(definition.name.as_str(), Some("shell"));
    let description = definition.description.to_utf8().unwrap();
    assert!(description.starts_with("Execute one shell command string. By default, commands use the host user's filesystem, process, and network authority."));
    assert!(description.contains("up to 3600000; zero or omission uses the 600000 ms default"));
    assert!(description.contains("running after 300000 ms move to the background"));
    let input =
        serde_json::from_str::<serde_json::Value>(&stringify_json(&definition.input_schema))
            .unwrap();
    assert_eq!(input["required"], serde_json::json!(["command"]));
    assert_eq!(input["properties"]["timeout"]["maximum"], 3_600_000);
    assert_eq!(input["properties"]["memory_limit_mb"]["maximum"], 1_048_576);
    assert_eq!(input["properties"]["background"]["type"], "boolean");
    let output = serde_json::from_str::<serde_json::Value>(&stringify_json(
        definition.output_schema.as_ref().unwrap(),
    ))
    .unwrap();
    assert!(output["properties"].get("output").is_none());
    assert_eq!(output["required"], serde_json::json!(["truncated"]));
    assert!(
        registry
            .materialize(&[permission::Rule {
                action: "shell".into(),
                resource: "*".into(),
                effect: permission::Effect("deny".into()),
            }])
            .definitions
            .is_empty()
    );

    for timeout in [600_001, 3_600_000] {
        let output = harness
            .call(serde_json::json!({"command": "true", "timeout": timeout}))
            .await
            .unwrap();
        assert_eq!(structured(&output)["exit"], 0);
    }
    for invalid in [
        serde_json::json!({"command": "true", "timeout": 3_600_001}),
        serde_json::json!({"command": "true", "timeout": -1}),
        serde_json::json!({"command": "true", "timeout": 1.5}),
    ] {
        assert_eq!(
            failure(harness.call(invalid).await),
            "Invalid tool input: Invalid timeout"
        );
    }
    assert_eq!(
        failure(
            harness
                .call(serde_json::json!({"command": "true", "memory_limit_mb": 1_048_577}))
                .await
        ),
        "Invalid tool input: Invalid memory_limit_mb"
    );
    assert_eq!(
        failure(harness.call(serde_json::json!({"timeout": 5})).await),
        "Invalid tool input: Expected string at command"
    );
    assert_eq!(
        failure(
            harness
                .call(serde_json::json!({"command": "true", "background": "yes"}))
                .await
        ),
        "Invalid tool input: Invalid background"
    );
    harness.finish().await;
}

#[tokio::test]
async fn returns_real_output_exit_and_model_text_from_the_active_location() {
    let harness = Harness::plain().await;
    let output = harness
        .call(serde_json::json!({"command": "printf hello"}))
        .await
        .unwrap();
    assert_eq!(
        structured(&output),
        serde_json::json!({"exit": 0, "truncated": false})
    );
    assert_eq!(texts(&output), ["hello", "Command exited with code 0."]);
    let nonzero = harness
        .call(serde_json::json!({"command": "printf body && exit 7"}))
        .await
        .unwrap();
    assert_eq!(
        structured(&nonzero),
        serde_json::json!({"exit": 7, "truncated": false})
    );
    assert_eq!(texts(&nonzero), ["body", "Command exited with code 7."]);
    let silent = harness
        .call(serde_json::json!({"command": "true"}))
        .await
        .unwrap();
    assert_eq!(texts(&silent)[0], "(no output)");
    let stderr = harness
        .call(serde_json::json!({"command": "printf 'stderr only' >&2"}))
        .await
        .unwrap();
    assert_eq!(texts(&stderr)[0], "stderr only");
    let mixed = harness
        .call(serde_json::json!({"command": "printf stdout; sleep 0.05; printf stderr >&2"}))
        .await
        .unwrap();
    let mixed = texts(&mixed)[0].clone();
    assert!(mixed.contains("stdout") && mixed.contains("stderr"));
    harness.finish().await;
}

#[tokio::test]
async fn resolves_relative_workdir_and_rejects_a_workdir_that_is_not_a_directory() {
    let harness = Harness::plain().await;
    std::fs::create_dir(harness.fixture.root.join("src")).unwrap();
    std::fs::write(harness.fixture.root.join("plain.txt"), "file").unwrap();
    let output = harness
        .call(serde_json::json!({"command": "pwd", "workdir": "src"}))
        .await
        .unwrap();
    assert!(texts(&output)[0].contains(harness.fixture.root.join("src").to_str().unwrap()));
    let marker = harness.fixture.root.join("marker");
    let command = format!("touch '{}'", marker.display());
    assert_eq!(
        failure(
            harness
                .call(serde_json::json!({"command": command, "workdir": "plain.txt"}))
                .await
        ),
        format!("Unable to execute command: {command}")
    );
    assert!(!marker.exists() && harness.shell.list().is_empty());
    harness.finish().await;
}

#[tokio::test]
async fn permission_patterns_deny_and_approve_commands_without_executing_denied_ones() {
    let harness = Harness::plain().await;
    let marker = harness.fixture.root.join("marker");
    rule(&harness.fixture, "shell", "touch *", "deny");
    let command = format!("touch '{}'", marker.display());
    assert_eq!(
        failure(harness.call(serde_json::json!({"command": command})).await),
        format!("Unable to execute command: {command}")
    );
    assert!(!marker.exists() && harness.shell.list().is_empty());
    assert_eq!(
        texts(
            &harness
                .call(serde_json::json!({"command": "printf ok"}))
                .await
                .unwrap()
        )[0],
        "ok"
    );
    harness.finish().await;
}

#[tokio::test]
async fn external_workdir_asks_external_directory_then_shell_and_denial_never_executes() {
    let harness = Harness::plain().await;
    let outside = ToolFixture::new();
    rule(&harness.fixture, "external_directory", "*", "ask");
    rule(&harness.fixture, "shell", "*", "ask");
    let tool = harness.tool.clone();
    let context = harness.fixture.context();
    let input = parse_json(
        &serde_json::json!({"command": "pwd", "workdir": outside.root.to_str().unwrap()})
            .to_string(),
    )
    .unwrap();
    let call = tokio::spawn(async move { tool.settle(input, context).await });
    let first =
        permission::Request::decode(&asked(&harness.fixture, "permission.asked", 0).await.data)
            .unwrap();
    assert_eq!(first.action.as_str(), Some("external_directory"));
    assert_eq!(
        first.resources[0].as_str(),
        Some(format!("{}/*", outside.root.display()).as_str())
    );
    harness
        .fixture
        .policy
        .permissions
        .reply(&first.id, permission::Reply("once".into()), None)
        .unwrap();
    let second =
        permission::Request::decode(&asked(&harness.fixture, "permission.asked", 1).await.data)
            .unwrap();
    assert_eq!(second.action.as_str(), Some("shell"));
    assert_eq!(second.resources[0].as_str(), Some("pwd"));
    assert_eq!(second.save, Some(vec!["pwd".into()]));
    harness
        .fixture
        .policy
        .permissions
        .reply(&second.id, permission::Reply("once".into()), None)
        .unwrap();
    let output = call.await.unwrap().unwrap();
    assert!(texts(&output)[0].contains(outside.root.to_str().unwrap()));
    harness.fixture.authority.events.lock().unwrap().clear();

    let marker = harness.fixture.root.join("marker");
    let command = format!("touch '{}'", marker.display());
    rule(&harness.fixture, "external_directory", "*", "deny");
    assert_eq!(
        failure(
            harness
                .call(serde_json::json!({"command": command, "workdir": outside.root.to_str().unwrap()}))
                .await
        ),
        format!("Unable to execute command: {command}")
    );
    assert!(!marker.exists());
    assert!(
        harness
            .fixture
            .authority
            .events
            .lock()
            .unwrap()
            .iter()
            .all(|event| event.type_ != "permission.asked")
    );
    outside.cleanup();
    harness.finish().await;
}

#[tokio::test]
async fn external_command_arguments_are_advisory_warnings_not_enforced_approval() {
    let harness = Harness::plain().await;
    let outside = ToolFixture::new();
    rule(&harness.fixture, "external_directory", "*", "deny");
    let target = outside.root.join("secret.txt");
    std::fs::write(&target, "secret").unwrap();
    let output = harness
        .call(serde_json::json!({"command": format!("cat {}", target.display())}))
        .await
        .unwrap();
    assert_eq!(
        structured(&output),
        serde_json::json!({"exit": 0, "truncated": false})
    );
    let texts = texts(&output);
    assert_eq!(texts[0], "secret");
    assert_eq!(
        texts[1],
        format!(
            "Warnings:\n- Command argument references external directory {}/*. Shell runs with host-user filesystem, process, and network authority; this scan is advisory only.\n\nCommand exited with code 0.",
            outside.root.display()
        )
    );
    outside.cleanup();
    harness.finish().await;
}

#[tokio::test]
async fn required_sandbox_fails_closed_before_approval_or_spawn_and_optional_warns() {
    let harness = Harness::new(
        "{\"shell\":\"/bin/sh\",\"shell_sandbox\":\"required\"}",
        AUTO_BACKGROUND,
    )
    .await;
    rule(&harness.fixture, "shell", "*", "ask");
    let marker = harness.fixture.root.join("marker");
    assert_eq!(
        failure(
            harness
                .call(serde_json::json!({"command": format!("touch '{}'", marker.display())}))
                .await
        ),
        "Shell sandboxing is required, but no enforceable backend is available."
    );
    assert!(!marker.exists());
    assert!(harness.fixture.authority.events.lock().unwrap().is_empty());
    harness.finish().await;

    let harness = Harness::new(
        "{\"shell\":\"/bin/sh\",\"shell_sandbox\":\"optional\"}",
        AUTO_BACKGROUND,
    )
    .await;
    let output = harness
        .call(serde_json::json!({"command": "printf hello"}))
        .await
        .unwrap();
    assert_eq!(
        texts(&output),
        [
            "hello".to_owned(),
            "Warnings:\n- No enforceable shell sandbox backend was available; command ran with host-user filesystem, process, and network authority.\n\nCommand exited with code 0.".to_owned()
        ]
    );
    harness.finish().await;

    let harness = Harness::new(
        "{\"shell\":\"/bin/sh\",\"shell_sandbox\":\"disabled\"}",
        AUTO_BACKGROUND,
    )
    .await;
    let output = harness
        .call(serde_json::json!({"command": "printf hello"}))
        .await
        .unwrap();
    assert_eq!(texts(&output), ["hello", "Command exited with code 0."]);
    harness.finish().await;
}

#[tokio::test]
async fn guardrail_denies_catastrophic_commands_and_reviews_gate_execution() {
    let harness = Harness::plain().await;
    let marker = harness.fixture.root.join("marker");
    let command = format!(
        "touch '{}'; mkfs.ext4 /dev/ycoding-absent",
        marker.display()
    );
    assert_eq!(
        failure(harness.call(serde_json::json!({"command": command})).await),
        format!("Session guardrail rejected shell command: {command}")
    );
    assert!(!marker.exists() && harness.shell.list().is_empty());
    harness.finish().await;

    for (decision, hard) in [
        (guardrail::RuleDecision::Ask, None),
        (guardrail::RuleDecision::HardReview, Some(true)),
    ] {
        let harness = Harness::with(
            ToolFixture::new().with_guardrail_rule(decision, "shell"),
            "{\"shell\":\"/bin/sh\"}",
            AUTO_BACKGROUND,
        )
        .await;
        let session = ycoding_schema::session_id::SessionId::new("ses_tool").unwrap();
        for (index, reply) in [guardrail::Reply::Once, guardrail::Reply::Reject]
            .into_iter()
            .enumerate()
        {
            let marker = harness.fixture.root.join(format!("marker{index}"));
            let command = format!("touch '{}'; printf reviewed", marker.display());
            let tool = harness.tool.clone();
            let context = harness.fixture.context();
            let input = parse_json(&serde_json::json!({"command": command}).to_string()).unwrap();
            let call = tokio::spawn(async move { tool.settle(input, context).await });
            let request = guardrail::Request::decode(
                &asked(&harness.fixture, "guardrail.asked", index).await.data,
            )
            .unwrap();
            assert_eq!(request.hard_review, hard);
            assert!(!marker.exists());
            let approve = reply == guardrail::Reply::Once;
            harness
                .fixture
                .policy
                .guardrails
                .reply(&session, &request.id, reply)
                .unwrap();
            let result = call.await.unwrap();
            if approve {
                assert_eq!(texts(&result.unwrap())[0], "reviewed");
                assert!(marker.exists());
            } else {
                assert_eq!(
                    failure(result),
                    format!("Session guardrail rejected shell command: {command}")
                );
                assert!(!marker.exists());
            }
        }
        harness.finish().await;
    }
}

#[tokio::test]
async fn memory_limit_hints_default_override_and_process_tree_termination() {
    let harness = Harness::new(
        "{\"shell\":\"/bin/sh\",\"shell_memory_limit_mb\":512}",
        AUTO_BACKGROUND,
    )
    .await;
    let hints = "printf '%s|%s' \"$GOMEMLIMIT\" \"$NODE_OPTIONS\"";
    let text = |memory: Option<u64>| {
        let mut input = serde_json::json!({"command": hints});
        if let Some(memory) = memory {
            input["memory_limit_mb"] = memory.into();
        }
        input
    };
    assert!(texts(&harness.call(text(None)).await.unwrap())[0].starts_with("512MiB|"));
    assert!(texts(&harness.call(text(Some(256))).await.unwrap())[0].starts_with("256MiB|"));
    assert!(
        texts(&harness.call(text(Some(256))).await.unwrap())[0]
            .contains("--max-old-space-size=256")
    );
    assert!(!texts(&harness.call(text(Some(0))).await.unwrap())[0].starts_with("512MiB|"));

    let output = harness
        .call(serde_json::json!({
            "command": "perl -e '$x = \"x\" x (200 * 1024 * 1024); sleep 20'",
            "memory_limit_mb": 64,
            "timeout": 20_000
        }))
        .await
        .unwrap();
    assert_eq!(
        structured(&output),
        serde_json::json!({"memoryLimit": true, "truncated": false})
    );
    assert_eq!(
        texts(&output),
        [
            "Command was terminated by the 64 MiB memory limit.",
            "Command exceeded its memory limit before completion."
        ]
    );
    harness.finish().await;
}

#[tokio::test]
async fn timeout_settles_with_a_useful_message() {
    let harness = Harness::plain().await;
    let output = harness
        .call(serde_json::json!({"command": "sleep 60", "timeout": 50}))
        .await
        .unwrap();
    assert_eq!(
        structured(&output),
        serde_json::json!({"timeout": true, "truncated": false})
    );
    assert_eq!(
        texts(&output),
        [
            "Command exceeded timeout of 50 ms. Retry with a larger timeout if the command is expected to take longer.",
            "Command timed out before completion."
        ]
    );
    harness.finish().await;
}

#[tokio::test]
async fn overflow_truncates_the_model_view_and_registry_spills_the_bounded_result() {
    let harness = Harness::plain().await;
    let bytes = MAX_CAPTURE_BYTES + 1024;
    let command = format!("head -c {bytes} /dev/zero | tr '\\0' 'x'");
    let output = harness
        .call(serde_json::json!({"command": command}))
        .await
        .unwrap();
    assert_eq!(
        structured(&output),
        serde_json::json!({"exit": 0, "truncated": true})
    );
    let text = texts(&output)[0].clone();
    assert!(text[..MAX_CAPTURE_BYTES].bytes().all(|byte| byte == b'x'));
    let notice = &text[MAX_CAPTURE_BYTES..];
    let file = notice
        .strip_prefix("\n\n[output truncated; full output saved to: ")
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap();
    assert_eq!(std::fs::metadata(file).unwrap().len() as usize, bytes);

    let registry = harness.fixture.registry();
    let _registration = registry
        .register(
            vec![("shell".into(), harness.tool.clone() as Arc<dyn Tool>)],
            Options::direct(),
        )
        .unwrap();
    let settlement = registry
        .materialize(&[])
        .invoke(
            "shell",
            parse_json(&serde_json::json!({"command": command}).to_string()).unwrap(),
            harness.fixture.context(),
        )
        .await
        .unwrap();
    assert_eq!(settlement.output_paths.len(), 1);
    harness.finish().await;
}

#[tokio::test]
async fn reports_bounded_output_progress_while_a_command_runs() {
    let harness = Harness::plain().await;
    let release = harness.fixture.root.join("release");
    let command = format!(
        "head -c {} /dev/zero | tr '\\0' 'x'; {}",
        MAX_CAPTURE_BYTES + 1024,
        release_loop(&release, "true")
    );
    let observed = Arc::new(AtomicUsize::new(0));
    let mut context = harness.fixture.context();
    let sink_release = release.clone();
    let sink_observed = observed.clone();
    context.progress = Some(Arc::new(move |update: Progress| {
        let release = sink_release.clone();
        let observed = sink_observed.clone();
        Box::pin(async move {
            let truncated = update.structured
                == match parse_json("{\"truncated\":true}").unwrap() {
                    JsonValue::Object(object) => object,
                    _ => unreachable!(),
                };
            let text = match &update.content[0] {
                ToolContent::Text(text) => text.text.to_utf8().unwrap(),
                ToolContent::File(_) => String::new(),
            };
            if truncated
                && text.find("\n\n[output truncated; full output saved to:")
                    == Some(MAX_CAPTURE_BYTES)
            {
                observed.fetch_add(1, Ordering::SeqCst);
                std::fs::write(release, "").unwrap();
            }
        })
    }));
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        harness.tool.settle(
            parse_json(&serde_json::json!({"command": command}).to_string()).unwrap(),
            context,
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(observed.load(Ordering::SeqCst) >= 1);
    assert_eq!(structured(&output)["truncated"], true);
    harness.finish().await;
}

#[tokio::test]
async fn background_command_returns_the_shell_id_owes_a_notice_and_delivers_completion() {
    let harness = Harness::plain().await;
    let release = harness.fixture.root.join("release");
    let command = release_loop(&release, "printf done");
    let output = harness
        .call(serde_json::json!({"command": command, "timeout": 10_000, "background": true}))
        .await
        .unwrap();
    let id = shell_id(&output);
    assert_eq!(
        structured(&output),
        serde_json::json!({"shellID": id, "truncated": false})
    );
    assert_eq!(
        texts(&output),
        [
            "The command was moved to the background.",
            "You will be notified automatically when the command finishes. DO NOT sleep, poll, or proactively check on its progress."
        ]
    );
    assert!(
        harness
            .shell
            .list()
            .iter()
            .any(|info| info.id.encode() == JsonValue::String(id.as_str().into()))
    );
    assert_eq!(harness.jobs.leases.load(Ordering::SeqCst), 1);
    assert_eq!(harness.jobs.background.lock().unwrap().len(), 1);
    let rows = harness
        .store
        .client()
        .snapshot()
        .unwrap()
        .scan::<ShellTable>(Bound::Unbounded, Bound::Unbounded, 8)
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session_id, Some("ses_tool".into()));
    assert_eq!(rows[0].notice_pending, 1);

    std::fs::write(&release, "").unwrap();
    let (job, delivered, state, text) =
        until(|| completed(&harness.jobs.notices.lock().unwrap())).await;
    assert_eq!(
        (
            job.command.as_str(),
            job.call_id.as_str(),
            delivered.as_str(),
            state,
            text.as_str()
        ),
        (
            command.as_str(),
            "call_tool",
            id.as_str(),
            "completed",
            "done"
        )
    );
    until(|| {
        let empty = harness
            .store
            .client()
            .snapshot()
            .unwrap()
            .scan::<ShellTable>(Bound::Unbounded, Bound::Unbounded, 8)
            .unwrap()
            .is_empty();
        (empty && harness.jobs.leases.load(Ordering::SeqCst) == 0).then_some(())
    })
    .await;
    harness.finish().await;
}

#[tokio::test]
async fn background_timeout_is_delivered_as_a_completed_notice() {
    let harness = Harness::plain().await;
    let output = harness
        .call(serde_json::json!({"command": "sleep 60", "timeout": 50, "background": true}))
        .await
        .unwrap();
    let id = shell_id(&output);
    let (_, delivered, state, text) =
        until(|| completed(&harness.jobs.notices.lock().unwrap())).await;
    assert_eq!((delivered, state), (id, "completed"));
    assert!(text.starts_with("Command exceeded timeout of 50 ms."));
    harness.finish().await;
}

#[tokio::test]
async fn a_session_signal_moves_a_foreground_command_to_the_background() {
    let harness = Harness::plain().await;
    let tool = harness.tool.clone();
    let context = harness.fixture.context();
    let input =
        parse_json(&serde_json::json!({"command": "sleep 60", "timeout": 0}).to_string()).unwrap();
    let call = tokio::spawn(async move { tool.settle(input, context).await });
    let (job, signal) = until(|| harness.jobs.foreground.lock().unwrap().first().cloned()).await;
    assert_eq!(
        (
            job.session_id.encode(),
            job.call_id.as_str(),
            job.command.as_str()
        ),
        (
            JsonValue::String("ses_tool".into()),
            "call_tool",
            "sleep 60"
        )
    );
    assert_eq!(harness.jobs.leases.load(Ordering::SeqCst), 1);
    signal.notify_one();
    let output = tokio::time::timeout(Duration::from_secs(30), call)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let id = shell_id(&output);
    assert_eq!(
        texts(&output)[0],
        "The command was moved to the background."
    );
    assert!(texts(&output)[1].contains("DO NOT sleep, poll"));
    assert!(
        harness
            .shell
            .list()
            .iter()
            .any(|info| info.id.encode() == JsonValue::String(id.as_str().into()))
    );
    assert!(harness.jobs.notices.lock().unwrap().is_empty());
    harness.finish().await;
}

#[tokio::test]
async fn foreground_commands_past_the_deadline_background_once_with_a_steer() {
    for timeout in [None, Some(0)] {
        let harness = Harness::new("{\"shell\":\"/bin/sh\"}", Duration::from_millis(300)).await;
        let release = harness.fixture.root.join("release");
        let command = release_loop(&release, "printf done");
        let mut input = serde_json::json!({"command": command});
        if let Some(timeout) = timeout {
            input["timeout"] = timeout.into();
        }
        let output = harness.call(input).await.unwrap();
        let id = shell_id(&output);
        assert_eq!(
            texts(&output)[0],
            "The command was moved to the background."
        );
        assert!(
            harness
                .shell
                .list()
                .iter()
                .any(|info| info.id.encode() == JsonValue::String(id.as_str().into()))
        );
        {
            let notices = harness.jobs.notices.lock().unwrap();
            assert_eq!(notices.len(), 1);
            match &notices[0] {
                Notice::Steer { session_id, text } => {
                    assert_eq!(session_id.encode(), JsonValue::String("ses_tool".into()));
                    assert!(text.len() <= 256 && text.contains("moved to the background"));
                }
                other => panic!("expected a steer, got {other:?}"),
            }
        }
        std::fs::write(&release, "").unwrap();
        let (job, delivered, state, text) =
            until(|| completed(&harness.jobs.notices.lock().unwrap())).await;
        assert_eq!(
            (job.command, delivered, state, text),
            (command, id, "completed", "done".to_owned())
        );
        harness.finish().await;
    }
}

#[tokio::test]
async fn explicit_background_has_no_steer_and_a_short_timeout_wins_without_detaching() {
    let harness = Harness::new("{\"shell\":\"/bin/sh\"}", Duration::from_millis(300)).await;
    let output = harness
        .call(serde_json::json!({"command": "sleep 60", "background": true}))
        .await
        .unwrap();
    let id = shell_id(&output);
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(harness.jobs.notices.lock().unwrap().is_empty());
    assert!(
        harness
            .shell
            .list()
            .iter()
            .any(|info| info.id.encode() == JsonValue::String(id.as_str().into()))
    );
    harness.finish().await;

    let harness = Harness::new("{\"shell\":\"/bin/sh\"}", Duration::from_secs(3)).await;
    let output = harness
        .call(serde_json::json!({"command": "sleep 60", "timeout": 300}))
        .await
        .unwrap();
    assert_eq!(structured(&output)["timeout"], true);
    assert!(harness.jobs.notices.lock().unwrap().is_empty());
    assert!(harness.jobs.background.lock().unwrap().is_empty());
    harness.finish().await;
}

#[tokio::test]
async fn a_long_explicit_timeout_survives_automatic_backgrounding() {
    let harness = Harness::new("{\"shell\":\"/bin/sh\"}", Duration::from_millis(300)).await;
    let output = harness
        .call(serde_json::json!({"command": "sleep 60", "timeout": 2500}))
        .await
        .unwrap();
    let id = shell_id(&output);
    assert_eq!(harness.shell.list().len(), 1);
    let (_, delivered, state, text) =
        until(|| completed(&harness.jobs.notices.lock().unwrap())).await;
    assert_eq!((delivered, state), (id, "completed"));
    assert!(text.starts_with("Command exceeded timeout of 2500 ms."));
    harness.finish().await;
}

#[tokio::test]
async fn a_shell_over_the_family_limit_waits_then_reports_the_shell_limit_instead_of_a_rejection() {
    let fixture =
        ToolFixture::new().with_guardrail_limits(ycoding_core::process::guardrails::Limits {
            shells: 1,
            shell_wait: Duration::from_secs(1),
            ..Default::default()
        });
    let harness = Harness::with(fixture, "{\"shell\":\"/bin/sh\"}", AUTO_BACKGROUND).await;
    let release = harness.fixture.root.join("release");
    let tool = harness.tool.clone();
    let context = harness.fixture.context();
    let input = parse_json(
        &serde_json::json!({"command": release_loop(&release, "echo released"), "timeout": 0})
            .to_string(),
    )
    .unwrap();
    let running = tokio::spawn(async move { tool.settle(input, context).await });
    until(|| harness.jobs.foreground.lock().unwrap().first().cloned()).await;
    assert_eq!(
        failure(harness.call(serde_json::json!({"command": "pwd"})).await),
        "Shell limit reached: 1/1 shells running in this session family (call_tool); waited 1s. Wait for or stop a running shell, or raise guardrails.max_concurrent_shells."
    );
    assert_eq!(harness.shell.list().len(), 1);
    std::fs::write(&release, "").unwrap();
    let output = tokio::time::timeout(Duration::from_secs(30), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(texts(&output).concat().contains("released"));
    assert!(
        texts(
            &harness
                .call(serde_json::json!({"command": "echo after"}))
                .await
                .unwrap()
        )
        .concat()
        .contains("after")
    );
    harness.finish().await;
}

#[tokio::test]
async fn interrupting_a_foreground_command_removes_it_once_and_cancels_the_deadline() {
    let harness = Harness::new("{\"shell\":\"/bin/sh\"}", Duration::from_millis(300)).await;
    let tool = harness.tool.clone();
    let context = harness.fixture.context();
    let cancellation = context.cancellation.clone();
    let input =
        parse_json(&serde_json::json!({"command": "sleep 60", "timeout": 0}).to_string()).unwrap();
    let call = tokio::spawn(async move { tool.settle(input, context).await });
    until(|| harness.jobs.foreground.lock().unwrap().first().cloned()).await;
    let file = harness.shell.list()[0].file.to_utf8().unwrap();
    cancellation.cancel();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(30), call)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err(),
        Failure::Cancelled
    );
    assert!(harness.shell.list().is_empty());
    assert!(!Path::new(&file).exists());
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(harness.jobs.notices.lock().unwrap().is_empty());
    assert_eq!(harness.jobs.leases.load(Ordering::SeqCst), 0);
    harness.finish().await;
}

#[tokio::test]
async fn a_linked_managed_worktree_needs_no_external_directory_approval() {
    let harness = Harness::plain().await;
    let git = |arguments: &[&str], directory: &Path| {
        assert!(
            std::process::Command::new("git")
                .args([
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid"
                ])
                .args(arguments)
                .current_dir(directory)
                .output()
                .unwrap()
                .status
                .success()
        );
    };
    git(&["init", "-b", "main"], &harness.fixture.root);
    git(
        &["commit", "--allow-empty", "-m", "root"],
        &harness.fixture.root,
    );
    let paths = harness.fixture.paths();
    let repository = paths.git.discover(&paths.directory).unwrap().unwrap();
    let linked =
        ycoding_core::platform::worktree::managed_destination(&paths.data, &repository, "linked")
            .unwrap();
    std::fs::create_dir_all(linked.parent().unwrap()).unwrap();
    git(
        &[
            "worktree",
            "add",
            "-b",
            "linked",
            linked.to_str().unwrap(),
            "HEAD",
        ],
        &harness.fixture.root,
    );
    rule(&harness.fixture, "external_directory", "*", "ask");
    rule(&harness.fixture, "shell", "*", "ask");
    let tool = harness.tool.clone();
    let context = harness.fixture.context();
    let input = parse_json(
        &serde_json::json!({"command": "pwd", "workdir": linked.to_str().unwrap()}).to_string(),
    )
    .unwrap();
    let call = tokio::spawn(async move { tool.settle(input, context).await });
    let first =
        permission::Request::decode(&asked(&harness.fixture, "permission.asked", 0).await.data)
            .unwrap();
    assert_eq!(first.action.as_str(), Some("shell"));
    harness
        .fixture
        .policy
        .permissions
        .reply(&first.id, permission::Reply("once".into()), None)
        .unwrap();
    let output = call.await.unwrap().unwrap();
    assert!(texts(&output)[0].contains(std::fs::canonicalize(&linked).unwrap().to_str().unwrap()));
    assert_eq!(
        harness
            .fixture
            .authority
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.type_ == "permission.asked")
            .count(),
        1
    );
    harness.finish().await;
}
