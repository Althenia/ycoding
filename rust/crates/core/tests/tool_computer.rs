include!("tool_fixture.rs");

use serde_json::json;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    platform::computer::{
        self,
        service::{Coordinator, Invoke},
        types::*,
    },
    tools::{
        builtin::computer::Computer,
        registry::{Options, Tool},
    },
};
use ycoding_schema::{JsonValue, guardrail::RuleDecision, parse_json};

struct Native(Arc<Mutex<Vec<String>>>);
impl Invoke for Native {
    fn invoke<'a>(
        &'a self,
        request: Request,
        _signal: tokio::sync::watch::Receiver<bool>,
    ) -> computer::Future<'a, Result<Success, NativeError>> {
        Box::pin(async move {
            self.0
                .lock()
                .unwrap()
                .push(format!("native:{}", request.operation.as_str()));
            Ok(Success {
                action: request.operation,
                revision: "rev-1".into(),
                detail: json!({"effect":"unchanged","tabIndex":2}),
            })
        })
    }
}

fn register(
    fixture: &ToolFixture,
    calls: &Arc<Mutex<Vec<String>>>,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "computer".into(),
                Arc::new(Computer {
                    service: Arc::new(
                        Coordinator::new(Arc::new(Native(calls.clone())), "darwin").service(),
                    ),
                    paths: fixture.paths(),
                    policy: fixture.policy.clone(),
                }) as Arc<dyn Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    (registry, registration)
}

async fn invoke(
    registry: &ycoding_core::tools::registry::Registry,
    fixture: &ToolFixture,
    input: serde_json::Value,
) -> ycoding_core::tools::materialization::Settlement {
    registry
        .materialize(&[])
        .invoke(
            "computer",
            parse_json(&input.to_string()).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap()
}

#[test]
fn the_advertised_definition_carries_the_typescript_contract() {
    let fixture = ToolFixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (registry, _registration) = register(&fixture, &calls);
    let materialized = registry.materialize(&[]);
    let definition = materialized
        .definitions
        .iter()
        .find(|definition| definition.name.as_str() == Some("computer"))
        .expect("computer is advertised");
    let schema = ycoding_schema::stringify_json(&definition.input_schema);
    assert!(schema.starts_with("{\"anyOf\":["));
    for action in [
        "webbrowser.tabs",
        "webbrowser.eval",
        "iterm.send_text",
        "finder.move",
        "desktop.click",
        "status",
        "cancel",
    ] {
        assert!(schema.contains(&format!("\"{action}\"")), "{action}");
    }
    fixture.cleanup();
}

#[tokio::test]
async fn status_needs_no_native_dispatch_and_a_denied_computer_permission_blocks_inspection() {
    let fixture = ToolFixture::new();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (registry, _registration) = register(&fixture, &calls);
    let status = invoke(&registry, &fixture, json!({"action":"status"})).await;
    assert!(
        ycoding_schema::stringify_json(&status.output.unwrap().structured)
            .contains("\"type\":\"status\"")
    );
    fixture.deny("computer", "*");
    let denied = invoke(
        &registry,
        &fixture,
        json!({"action":"webbrowser.tabs","platform":"macos","bundle_id":"com.apple.Safari"}),
    )
    .await;
    assert_eq!(
        denied.result,
        ToolResultValue::Error(JsonValue::String("Permission denied: computer".into()))
    );
    assert!(calls.lock().unwrap().is_empty());
    fixture.cleanup();
}

#[tokio::test]
async fn finder_moves_outside_the_repository_run_through_the_boundary_and_native_dispatch() {
    let fixture = ToolFixture::new();
    let outside = std::fs::canonicalize(std::env::temp_dir())
        .unwrap()
        .join(format!("computer_outside_{}", std::process::id()));
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("old.txt"), "x").unwrap();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (registry, _registration) = register(&fixture, &calls);
    let inspected = invoke(
        &registry,
        &fixture,
        json!({"action": "finder.inspect", "platform": "macos", "path": outside.join("old.txt")}),
    )
    .await;
    assert!(matches!(
        inspected.result,
        ToolResultValue::Text(_) | ToolResultValue::Json(_)
    ));
    let moved = tokio::time::timeout(
        Duration::from_secs(5),
        invoke(
            &registry,
            &fixture,
            json!({
                "action": "finder.move",
                "platform": "macos",
                "path": outside.join("old.txt"),
                "destination_directory": outside.join("moved"),
                "expected_revision": "rev-1",
            }),
        ),
    )
    .await
    .expect("the move must not wait for a human decision");
    assert!(
        matches!(
            moved.result,
            ToolResultValue::Text(_) | ToolResultValue::Json(_)
        ),
        "{:?}",
        moved.result
    );
    assert_eq!(
        *calls.lock().unwrap(),
        vec!["native:finder.inspect", "native:finder.move"]
    );
    std::fs::remove_dir_all(outside).unwrap();
    fixture.cleanup();
}

fn is_guardrail_rejection(result: &ToolResultValue) -> bool {
    matches!(
        result,
        ToolResultValue::Error(JsonValue::String(message))
            if message.as_str().is_some_and(|text| text.starts_with("Session guardrail rejected"))
    )
}

async fn settled_without_a_human_reply(
    registry: &ycoding_core::tools::registry::Registry,
    fixture: &ToolFixture,
    input: serde_json::Value,
) -> ycoding_core::tools::materialization::Settlement {
    tokio::time::timeout(Duration::from_secs(5), invoke(registry, fixture, input))
        .await
        .expect("an admitted review must not wait for a human reply")
}

#[tokio::test]
async fn skip_review_admits_ordinary_and_hard_shell_reviews_but_a_deny_still_blocks() {
    let ordinary = "touch /elsewhere/file";
    let hard = "git reset --hard";
    let denied = ["rm", "-rf", "/"].join(" ");
    for (command, admitted) in [(ordinary, true), (hard, true), (denied.as_str(), false)] {
        let fixture = ToolFixture::new();
        if command == hard {
            let evaluation = fixture
                .policy
                .guardrails
                .evaluate(&ycoding_core::process::guardrails::Input {
                    session_id: fixture.context().session_id,
                    action: "shell".into(),
                    resources: vec![command.into()],
                    metadata: None,
                    skip_review: false,
                    holder: None,
                    source: None,
                })
                .unwrap();
            assert_eq!(evaluation.effect, ycoding_core::tools::policy::Effect::Ask);
            assert!(evaluation.standard);
            assert!(evaluation.hard_review);
            assert_eq!(
                evaluation.rule_ids,
                vec!["standard.review.git-destructive".into()]
            );
        }
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (registry, _registration) = register(&fixture, &calls);
        invoke(
            &registry,
            &fixture,
            json!({
                "action": "iterm.inspect",
                "platform": "macos",
                "window_id": 1,
                "tab_index": 1,
                "session_id": "session",
            }),
        )
        .await;
        calls.lock().unwrap().clear();
        let settlement = settled_without_a_human_reply(
            &registry,
            &fixture,
            json!({
                "action": "iterm.send_text",
                "platform": "macos",
                "window_id": 1,
                "tab_index": 1,
                "session_id": "session",
                "expected_revision": "rev-1",
                "text": command,
            }),
        )
        .await;
        if admitted {
            assert!(
                settlement.output.is_some(),
                "{command}: {:?}",
                settlement.result
            );
            assert_eq!(
                *calls.lock().unwrap(),
                vec!["native:iterm.send_text"],
                "{command}"
            );
        } else {
            assert!(
                is_guardrail_rejection(&settlement.result),
                "{:?}",
                settlement.result
            );
            assert!(calls.lock().unwrap().is_empty());
        }
        fixture.cleanup();
    }
}

#[tokio::test]
async fn skip_review_admits_ordinary_and_hard_computer_reviews_but_a_deny_still_blocks() {
    for (decision, admitted) in [
        (RuleDecision::Ask, true),
        (RuleDecision::HardReview, true),
        (RuleDecision::Deny, false),
    ] {
        let fixture = ToolFixture::new().with_guardrail_rule(decision, "computer");
        let calls = Arc::new(Mutex::new(Vec::new()));
        let (registry, _registration) = register(&fixture, &calls);
        let settlement = settled_without_a_human_reply(
            &registry,
            &fixture,
            json!({"action":"webbrowser.tabs","platform":"macos","bundle_id":"com.apple.Safari"}),
        )
        .await;
        if admitted {
            assert!(
                settlement.output.is_some(),
                "{decision:?}: {:?}",
                settlement.result
            );
            assert_eq!(
                *calls.lock().unwrap(),
                vec!["native:webbrowser.tabs"],
                "{decision:?}"
            );
        } else {
            assert!(
                is_guardrail_rejection(&settlement.result),
                "{:?}",
                settlement.result
            );
            assert!(calls.lock().unwrap().is_empty());
        }
        fixture.cleanup();
    }
}
