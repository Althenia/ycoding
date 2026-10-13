include!("tool_fixture.rs");

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    platform::browser::boundary::Paired,
    platform::browser::bridge::Bridge,
    tools::{
        builtin::browser::Browser,
        registry::{Options, Tool},
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, browser, guardrail::RuleDecision, parse_json, session_id::SessionId,
};

fn decode<T: DomainDecode>(value: serde_json::Value) -> T {
    T::decode(&parse_json(&value.to_string()).unwrap()).unwrap()
}

struct Chrome {
    tabs: Vec<browser::Tab>,
    opens: Arc<AtomicUsize>,
}
impl Paired for Chrome {
    fn open<'a>(
        &'a self,
        _input: browser::OpenInput,
    ) -> ycoding_core::platform::computer::Future<'a, Result<browser::Tab, String>> {
        Box::pin(async move {
            self.opens.fetch_add(1, Ordering::SeqCst);
            Ok(tab())
        })
    }
    fn bridge(&self) -> Result<Arc<Bridge>, String> {
        Err("The paired bridge is unavailable".into())
    }
    fn status(&self, _session: &SessionId) -> Result<browser::Status, String> {
        Ok(decode(
            serde_json::json!({"state":"connected","paired":true,"profileGranted":true}),
        ))
    }
    fn list(&self, _session: &SessionId) -> Result<Vec<browser::Tab>, String> {
        Ok(self.tabs.clone())
    }
}

fn tab() -> browser::Tab {
    decode(serde_json::json!({
        "id": "btab_one",
        "sessionID": "ses_tool",
        "title": "Docs",
        "page": {"origin": "https://example.test", "path": "/docs"},
        "status": "shared",
        "generation": 1,
        "documentGeneration": 1,
        "observationRevision": 0,
        "mode": "profile",
        "lease": "self"
    }))
}

fn register(
    fixture: &ToolFixture,
    tabs: Vec<browser::Tab>,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    register_counting(fixture, tabs, Arc::default())
}

fn register_counting(
    fixture: &ToolFixture,
    tabs: Vec<browser::Tab>,
    opens: Arc<AtomicUsize>,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "browser".into(),
                Arc::new(Browser {
                    paired: Arc::new(Chrome { tabs, opens }),
                    isolated: None,
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
    input: &str,
) -> ycoding_core::tools::materialization::Settlement {
    registry
        .materialize(&[])
        .invoke("browser", parse_json(input).unwrap(), fixture.context())
        .await
        .unwrap()
}

#[test]
fn the_advertised_definition_carries_the_typescript_contract() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register(&fixture, vec![]);
    let materialized = registry.materialize(&[]);
    let definition = materialized
        .definitions
        .iter()
        .find(|definition| definition.name.as_str() == Some("browser"))
        .expect("browser is advertised");
    let description = definition.description.as_str().unwrap();
    assert!(
        description.starts_with("Use status once, then tabs. Reuse returned tabID, generation,")
    );
    assert!(
        description.contains("mode:'isolated' uses the user-started temporary headless browser")
    );
    let schema = ycoding_schema::stringify_json(&definition.input_schema);
    assert!(schema.starts_with("{\"anyOf\":["));
    for operation in [
        "status", "tabs", "observe", "action", "control", "stop", "open", "close", "release",
    ] {
        assert!(schema.contains(&format!("\"{operation}\"")), "{operation}");
    }
    fixture.cleanup();
}

#[tokio::test]
async fn status_and_tabs_flow_through_the_boundary_with_read_permission() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register(&fixture, vec![tab()]);
    let status = invoke(&registry, &fixture, r#"{"operation":"status"}"#).await;
    assert_eq!(
        status.output.unwrap().structured,
        parse_json(r#"{"type":"status","status":{"state":"connected","paired":true,"profileGranted":true}}"#).unwrap()
    );
    let tabs = invoke(&registry, &fixture, r#"{"operation":"tabs"}"#).await;
    let structured = tabs.output.unwrap().structured;
    assert!(ycoding_schema::stringify_json(&structured).contains("\"type\":\"tabs\""));
    assert!(ycoding_schema::stringify_json(&structured).contains("btab_one"));
    fixture.cleanup();
}

#[tokio::test]
async fn a_denied_read_permission_still_blocks_the_tab_listing() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register(&fixture, vec![tab()]);
    fixture.deny("browser_read", "*");
    let denied = invoke(&registry, &fixture, r#"{"operation":"tabs"}"#).await;
    assert_eq!(
        denied.result,
        ToolResultValue::Error(JsonValue::String("Permission denied: browser_read".into()))
    );
    assert!(denied.output.is_none());
    fixture.cleanup();
}

#[tokio::test]
async fn invalid_operations_and_unconfigured_isolated_mode_fail_without_side_effects() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register(&fixture, vec![]);
    let unknown = invoke(&registry, &fixture, r#"{"operation":"teleport"}"#).await;
    assert_eq!(
        unknown.result,
        ToolResultValue::Error(JsonValue::String("Invalid browser operation".into()))
    );
    let isolated = invoke(
        &registry,
        &fixture,
        r#"{"operation":"status","mode":"isolated"}"#,
    )
    .await;
    assert_eq!(
        isolated.result,
        ToolResultValue::Error(JsonValue::String(
            "Isolated browser service is not configured".into()
        ))
    );
    fixture.cleanup();
}

#[tokio::test]
async fn skip_review_admits_ordinary_and_hard_reviews_but_a_deny_still_blocks() {
    for (decision, admitted) in [
        (RuleDecision::Ask, true),
        (RuleDecision::HardReview, true),
        (RuleDecision::Deny, false),
    ] {
        let fixture = ToolFixture::new().with_guardrail_rule(decision, "browser_owned_open");
        let opens = Arc::new(AtomicUsize::new(0));
        let (registry, _registration) = register_counting(&fixture, vec![], opens.clone());
        let settlement = tokio::time::timeout(
            Duration::from_secs(5),
            invoke(
                &registry,
                &fixture,
                r#"{"operation":"open","mode":"owned","generation":1,"url":"https://example.test/docs"}"#,
            ),
        )
        .await
        .expect("an admitted review must not wait for a human reply");
        if admitted {
            assert!(
                settlement.output.is_some(),
                "{decision:?}: {:?}",
                settlement.result
            );
            assert_eq!(opens.load(Ordering::SeqCst), 1, "{decision:?}");
        } else {
            assert!(
                matches!(
                    &settlement.result,
                    ToolResultValue::Error(JsonValue::String(message))
                        if message.as_str().is_some_and(|text| text.starts_with("Session guardrail rejected"))
                ),
                "{:?}",
                settlement.result
            );
            assert_eq!(opens.load(Ordering::SeqCst), 0);
        }
        fixture.cleanup();
    }
}
