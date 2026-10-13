#![cfg(unix)]
include!("tool_fixture.rs");

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Notify;
use ycoding_core::{
    job::{self, Status},
    platform::shell::Shell,
    resources::config::{Configuration, LoadOptions, Roots},
    tools::{
        builtin::shell::{AUTO_BACKGROUND, Deliver, JobShells, NoticeFuture, ShellTool},
        registry::Tool,
    },
};
use ycoding_schema::{
    JsonValue, parse_json, session, session_delivery::Delivery, session_pending, stringify_json,
};

type Delivered = Arc<Mutex<Vec<(session::Id, session_pending::Message)>>>;

struct Harness {
    fixture: ToolFixture,
    store: ycoding_store::Store,
    shell: Arc<Shell>,
    jobs: job::Jobs,
    delivered: Delivered,
    gate: Arc<Mutex<Option<Arc<Notify>>>>,
    outcome: Arc<Mutex<std::io::ErrorKind>>,
    tool: Arc<ShellTool>,
}

impl Harness {
    async fn new(auto_background: Duration) -> Self {
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
        let jobs = job::Jobs::new();
        let delivered = Delivered::default();
        let gate = Arc::new(Mutex::new(None::<Arc<Notify>>));
        let outcome = Arc::new(Mutex::new(std::io::ErrorKind::Other));
        let deliver: Deliver = {
            let (delivered, gate, outcome) = (delivered.clone(), gate.clone(), outcome.clone());
            Arc::new(move |session_id, message| -> NoticeFuture {
                delivered.lock().unwrap().push((session_id, message));
                let waiting = gate.lock().unwrap().clone();
                let failure = *outcome.lock().unwrap();
                Box::pin(async move {
                    if let Some(waiting) = waiting {
                        waiting.notified().await;
                    }
                    match failure {
                        std::io::ErrorKind::Other => Ok(()),
                        kind => Err(std::io::Error::new(kind, "delivery failed")),
                    }
                })
            })
        };
        let tool = Arc::new(ShellTool {
            shell: shell.clone(),
            configuration,
            paths: fixture.paths(),
            policy: fixture.policy.clone(),
            jobs: Arc::new(JobShells::new(jobs.clone(), deliver)),
            auto_background,
        });
        Self {
            fixture,
            store,
            shell,
            jobs,
            delivered,
            gate,
            outcome,
            tool,
        }
    }

    async fn call(&self, input: serde_json::Value) -> ycoding_ai::llm::ToolOutput {
        tokio::time::timeout(
            Duration::from_secs(30),
            self.tool.settle(
                parse_json(&input.to_string()).unwrap(),
                self.fixture.context(),
            ),
        )
        .await
        .expect("shell tool call exceeds 30 seconds")
        .expect("shell tool call fails")
    }

    fn outstanding(&self) -> bool {
        self.jobs
            .outstanding_sessions()
            .contains(&session::Id::new("ses_tool").unwrap())
    }

    async fn finish(self) {
        self.shell.shutdown().await.unwrap();
        drop(self.tool);
        drop(self.shell);
        self.store.shutdown().unwrap();
        self.fixture.cleanup();
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

fn synthetic(message: &session_pending::Message) -> (String, Option<String>, String, Delivery) {
    let session_pending::Message::Synthetic(message) = message else {
        panic!("expected a synthetic input")
    };
    (
        message.data.text.to_utf8().unwrap(),
        message
            .data
            .description
            .as_ref()
            .map(|text| text.to_utf8().unwrap()),
        message
            .data
            .metadata
            .as_ref()
            .map(|metadata| stringify_json(&JsonValue::Object(metadata.clone())))
            .unwrap_or_default(),
        message.delivery,
    )
}

#[tokio::test]
async fn a_background_shell_stays_outstanding_until_its_completion_notice_is_admitted() {
    let harness = Harness::new(AUTO_BACKGROUND).await;
    let release = harness.fixture.root.join("release");
    let command = release_loop(&release, "echo done");
    let hold = Arc::new(Notify::new());
    *harness.gate.lock().unwrap() = Some(hold.clone());

    let output = harness
        .call(serde_json::json!({"command": command, "background": true}))
        .await;
    assert!(stringify_json(&output.structured).contains("shellID"));
    let info = harness.jobs.get("call_tool").unwrap();
    assert_eq!(
        (info.kind.as_str(), info.title.as_deref(), info.status),
        ("shell", Some(command.as_str()), Status::Running)
    );
    assert_eq!(
        info.metadata.unwrap().get("sessionID"),
        Some(&serde_json::json!("ses_tool"))
    );
    assert!(harness.outstanding());

    std::fs::write(&release, "").unwrap();
    until(|| (!harness.delivered.lock().unwrap().is_empty()).then_some(())).await;
    assert!(harness.outstanding());
    assert_eq!(
        harness.jobs.get("call_tool").unwrap().status,
        Status::Running
    );

    hold.notify_one();
    until(|| (!harness.outstanding()).then_some(())).await;
    until(|| (harness.jobs.get("call_tool")?.status == Status::Completed).then_some(())).await;

    let delivered = harness.delivered.lock().unwrap().clone();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].0, session::Id::new("ses_tool").unwrap());
    let (text, description, metadata, delivery) = synthetic(&delivered[0].1);
    assert_eq!(
        text,
        format!(
            "<shell id=\"call_tool\" state=\"completed\" command=\"{command}\">\ndone\n\n</shell>"
        )
    );
    assert_eq!(description.as_deref(), Some(command.as_str()));
    assert_eq!(metadata, r#"{"source":"shell","state":"completed"}"#);
    assert_eq!(delivery, Delivery::Steer);
    harness.finish().await;
}

#[tokio::test]
async fn a_completion_notice_that_fails_to_deliver_keeps_the_session_outstanding() {
    let harness = Harness::new(AUTO_BACKGROUND).await;
    *harness.outcome.lock().unwrap() = std::io::ErrorKind::BrokenPipe;

    harness
        .call(serde_json::json!({"command": "echo done", "background": true}))
        .await;
    until(|| (!harness.delivered.lock().unwrap().is_empty()).then_some(())).await;
    until(|| (harness.jobs.get("call_tool")?.status == Status::Completed).then_some(())).await;

    assert!(harness.outstanding());
    harness.finish().await;
}

#[tokio::test]
async fn a_foreground_shell_that_finishes_is_not_outstanding_and_delivers_nothing() {
    let harness = Harness::new(AUTO_BACKGROUND).await;
    assert!(
        harness
            .call(serde_json::json!({"command": "echo done"}))
            .await
            .structured
            != JsonValue::Null
    );

    until(|| (harness.jobs.get("call_tool")?.status == Status::Completed).then_some(())).await;
    assert!(!harness.outstanding());
    assert!(harness.delivered.lock().unwrap().is_empty());
    harness.finish().await;
}

#[tokio::test]
async fn a_user_background_request_moves_a_foreground_shell_and_keeps_it_outstanding() {
    let harness = Harness::new(AUTO_BACKGROUND).await;
    let release = harness.fixture.root.join("release");
    let command = release_loop(&release, "echo moved");
    let running = tokio::spawn({
        let (tool, context) = (harness.tool.clone(), harness.fixture.context());
        let input = parse_json(&serde_json::json!({"command": command}).to_string()).unwrap();
        async move { tool.settle(input, context).await }
    });

    until(|| harness.jobs.get("call_tool")).await;
    let moved = harness
        .jobs
        .background_all(&session::Id::new("ses_tool").unwrap(), Some("shell"));
    assert_eq!(moved.len(), 1);

    let output = tokio::time::timeout(Duration::from_secs(30), running)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(stringify_json(&output.structured).contains("shellID"));
    assert!(harness.outstanding());
    assert_eq!(
        harness.jobs.get("call_tool").unwrap().status,
        Status::Running
    );

    std::fs::write(&release, "").unwrap();
    until(|| (!harness.outstanding()).then_some(())).await;
    let delivered = harness.delivered.lock().unwrap().clone();
    assert_eq!(delivered.len(), 1);
    assert!(synthetic(&delivered[0].1).0.contains("state=\"completed\""));
    harness.finish().await;
}

#[tokio::test]
async fn the_foreground_deadline_delivers_a_steer_and_keeps_the_shell_outstanding() {
    let harness = Harness::new(Duration::from_millis(100)).await;
    let release = harness.fixture.root.join("release");
    let command = release_loop(&release, "echo late");

    harness
        .call(serde_json::json!({"command": command, "timeout": 60000}))
        .await;
    assert!(harness.outstanding());
    assert_eq!(
        harness.jobs.get("call_tool").unwrap().status,
        Status::Running
    );
    {
        let delivered = harness.delivered.lock().unwrap();
        assert_eq!(delivered.len(), 1);
        let (text, description, metadata, delivery) = synthetic(&delivered[0].1);
        assert_eq!(
            text,
            "The foreground shell exceeded 300 seconds and was moved to the background. Continue without waiting; completion will be delivered automatically."
        );
        assert_eq!(
            (description, metadata, delivery),
            (None, String::new(), Delivery::Steer)
        );
    }

    std::fs::write(&release, "").unwrap();
    until(|| (!harness.outstanding()).then_some(())).await;
    assert_eq!(harness.delivered.lock().unwrap().len(), 2);
    harness.finish().await;
}
