include!("tool_fixture.rs");

use std::sync::Arc;
use ycoding_ai::llm::ToolResultValue;
use ycoding_core::{
    resources::project_artifact::{
        source_registry::Registry as SourceRegistry,
        store::{Paths, Service},
    },
    tools::{builtin::project_artifact::ProjectArtifact, registry::Options},
};
use ycoding_schema::{JsonValue, parse_json, project};

fn register_project_artifact(
    fixture: &ToolFixture,
) -> (
    ycoding_core::tools::registry::Registry,
    ycoding_core::tools::registry::Registration,
) {
    let service = Arc::new(Service::new(
        fixture.authority.store.client(),
        Paths {
            data: fixture.root.join("data"),
            home: fixture.root.clone(),
            config: fixture.root.join("config"),
        },
        Arc::new(std::sync::Mutex::new(SourceRegistry::default())),
    ));
    let project_id = project::Id::new("project").unwrap();
    let registry = fixture.registry();
    let registration = registry
        .register(
            vec![(
                "project_artifact".into(),
                Arc::new(ProjectArtifact {
                    store: service,
                    project_id,
                    policy: fixture.policy.clone(),
                }) as Arc<dyn ycoding_core::tools::registry::Tool>,
            )],
            Options::direct(),
        )
        .unwrap();
    (registry, registration)
}

#[tokio::test]
async fn automatically_writes_a_trial_artifact_and_reports_quota() {
    let fixture = ToolFixture::new();
    let (registry, _registration) = register_project_artifact(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "project_artifact",
            parse_json(r#"{"kind":"skill","id":"repo-boundary","insight_key":"workspace verification","name":"Workspace verification","description":"Verify Rust workspace boundaries","content":"Check the workspace identity and focused tests."}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Text(_)));
    let JsonValue::Object(output) = result.output.unwrap().structured else {
        panic!("expected project artifact result")
    };
    assert_eq!(
        output.get(&"stage".into()),
        Some(&JsonValue::String("trial".into()))
    );
    assert_eq!(
        output.get(&"result".into()),
        Some(&JsonValue::String("created".into()))
    );
    let Some(JsonValue::Object(remaining)) = output.get(&"remaining".into()) else {
        panic!("expected quota output")
    };
    assert_eq!(
        remaining.get(&"session".into()),
        Some(&JsonValue::Number(2.0))
    );
    fixture.cleanup();
}

#[tokio::test]
async fn project_artifact_permission_denial_has_no_storage_side_effects() {
    let fixture = ToolFixture::new();
    fixture.deny("project_artifact", "repo-boundary");
    let (registry, _registration) = register_project_artifact(&fixture);
    let result = registry
        .materialize(&[])
        .invoke(
            "project_artifact",
            parse_json(r#"{"kind":"skill","id":"repo-boundary","insight_key":"workspace verification","name":"Workspace verification","description":"Verify Rust workspace boundaries","content":"Check the workspace identity and focused tests."}"#).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    assert!(matches!(result.result, ToolResultValue::Error(_)));
    assert!(!fixture.root.join("data").exists());
    fixture.cleanup();
}
