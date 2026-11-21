include!("tool_fixture.rs");
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::watch;
use ycoding_core::{
    platform::{
        computer::Future,
        interaction::{Authority, Driver, Error, Operation, Options},
    },
    tools::{builtin::interaction::Interaction, registry::Tool},
};
use ycoding_schema::{parse_json, stringify_json};
struct Chrome(AtomicU64);
const TARGET: &str = "10000000-0000-4000-8000-000000000001";
const LEASE: &str = "10000000-0000-4000-8000-000000000002";
impl Driver for Chrome {
    fn platform(&self) -> &'static str {
        "chrome"
    }
    fn call(
        &self,
        op: Operation,
        _: Value,
        _: watch::Receiver<bool>,
    ) -> Future<'_, Result<Value, Error>> {
        Box::pin(async move {
            Ok(match op {
                Operation::Inventory => {
                    json!([{"kind":"chrome-tab","id":TARGET,"label":"Fixture","origin":"https://example.test","pathname":"/"}])
                }
                Operation::Attach => json!({"id":LEASE}),
                Operation::Observe => {
                    json!({"revision":self.0.fetch_add(1,Ordering::SeqCst)+1,"pathname":"/","elements":[]})
                }
                Operation::Perform => json!({"outcome":"applied"}),
                Operation::Run => json!({"outcome":"completed","value":42,"logs":[]}),
                Operation::Resume => json!(true),
                _ => Value::Null,
            })
        })
    }
}
#[tokio::test]
async fn tool_consent_permissions_pauses_and_fences_match_the_public_contract() {
    let fixture = ToolFixture::new();
    let authority = Authority::new(Options::default());
    let native = authority
        .register("chrome", Arc::new(Chrome(AtomicU64::new(0))))
        .unwrap();
    let registry = fixture.registry();
    let _registration = registry
        .register(
            vec![(
                "interaction".into(),
                Arc::new(Interaction {
                    authority: authority.clone(),
                    paths: fixture.paths(),
                    policy: fixture.policy.clone(),
                }) as Arc<dyn Tool>,
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    let tools = registry.materialize(&[]);
    let requested = tools
        .invoke(
            "interaction",
            parse_json(r#"{"operation":"request","selection":{"platform":"chrome"}}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    let value = stringify_json(&requested.output.unwrap().structured);
    assert!(value.contains("pending"));
    let status = authority.status("ses_tool");
    let generation = status["generation"].as_str().unwrap();
    let candidate = native.pending()[0].clone();
    native
        .inventory(candidate["candidateID"].as_str().unwrap())
        .await;
    assert!(native.approve(json!({"candidateID":candidate["candidateID"],"sessionID":"ses_tool","targetID":TARGET,"authorization":"fixture-native-consent"})).await);
    let observe = json!({"operation":"observe","generation":generation});
    let observed = tools
        .invoke(
            "interaction",
            parse_json(&observe.to_string()).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(stringify_json(&observed.output.unwrap().structured).contains("\"revision\":1"));
    assert!(native.pause(LEASE, "foreground_required"));
    let paused = tools
        .invoke(
            "interaction",
            parse_json(&observe.to_string()).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(stringify_json(&paused.output.unwrap().structured).contains("foreground_required"));
    assert!(native.resume(LEASE));
    fixture.deny("browser_script", "*");
    let script = json!({"operation":"run","generation":generation,"revision":1,"script":{"mode":"script","source":"return 42"}});
    let denied = tools
        .invoke(
            "interaction",
            parse_json(&script.to_string()).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(denied.output.is_none());
    authority.stop("ses_tool", generation);
    let stopped = tools
        .invoke(
            "interaction",
            parse_json(&observe.to_string()).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(stopped.output.is_none());
    authority.shutdown().await.unwrap();
    fixture.cleanup();
}
#[tokio::test]
async fn tool_rejects_unknown_operations_and_never_exposes_preview_pixels() {
    let fixture = ToolFixture::new();
    let authority = Authority::new(Options::default());
    let tool = Interaction {
        authority: authority.clone(),
        paths: fixture.paths(),
        policy: fixture.policy.clone(),
    };
    let definition = tool.definition("interaction");
    assert!(stringify_json(&definition.input_schema).contains("\"run\""));
    assert!(!stringify_json(&definition.input_schema).contains("\"preview\""));
    assert!(
        tool.settle(
            parse_json(r#"{"operation":"preview"}"#).unwrap(),
            fixture.context()
        )
        .await
        .is_err()
    );
    authority.shutdown().await.unwrap();
    fixture.cleanup();
}
