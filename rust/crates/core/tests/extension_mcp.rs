include!("tool_fixture.rs");
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use ycoding_core::extension::{
    Configuration, Extension, FamilyGrant, Host, Options, ToolGrant, v5,
};
use ycoding_core::resources::{
    config::Entry,
    mcp::{Service, client::Hooks},
};
use ycoding_schema::{parse_json, stringify_json};

fn service(fixture: &ToolFixture) -> Arc<Service> {
    let source = std::process::Command::new("bun")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src/resources/mcp/extract-fixture.mjs"),
        )
        .arg("mcp-timeout")
        .arg(&fixture.root)
        .output()
        .unwrap();
    assert!(
        source.status.success(),
        "{}",
        String::from_utf8_lossy(&source.stderr)
    );
    let server =
        json!({"type":"local","command":["bun",String::from_utf8(source.stdout).unwrap()]});
    let entries = [Entry::Document {
        path: None,
        info: parse_json(&json!({"mcp":{"servers":{"docs":server,"other":server}}}).to_string())
            .unwrap(),
    }];
    Arc::new(
        Service::new(
            &entries,
            fixture.root.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap(),
    )
}
fn configuration(fixture: &ToolFixture, mode: &str) -> Configuration {
    Configuration {
        identity: "fixture".into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            mode.into(),
        ],
        directory: fixture.root.clone(),
        registration_order: 0,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: vec![FamilyGrant {
            family: v5::CapabilityFamily::Mcp,
            scopes: vec!["docs".into()],
            action: "extension.mcp".into(),
            resources: vec!["docs".into()],
        }],
    }
}
async fn start(
    fixture: &ToolFixture,
    mode: &str,
    registry: &ycoding_core::tools::registry::Registry,
    host: Host,
) -> Extension {
    Extension::start(
        configuration(fixture, mode),
        Options {
            startup: Duration::from_secs(1),
            execution: Duration::from_secs(10),
            cleanup: Duration::from_millis(100),
            shutdown: Duration::from_millis(100),
            write: Duration::from_millis(500),
        },
        registry,
        fixture.policy.clone(),
        &fixture.context(),
        host,
    )
    .await
    .unwrap()
}
async fn summary(
    fixture: &ToolFixture,
    registry: &ycoding_core::tools::registry::Registry,
) -> Value {
    let settlement = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await
        .unwrap();
    assert!(settlement.error.is_none());
    serde_json::from_str(&stringify_json(&settlement.output.unwrap().structured)).unwrap()
}

#[tokio::test]
async fn granted_mcp_calls_serve_the_owned_invocation_inside_their_server_scope() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let service = service(&fixture);
    let extension = start(
        &fixture,
        "mcp_calls",
        &registry,
        Host {
            mcp: Some(service.clone()),
            ..Host::default()
        },
    )
    .await;
    let summary = summary(&fixture, &registry).await;
    assert_eq!(summary["servers"]["value"].as_array().unwrap().len(), 1);
    assert_eq!(summary["servers"]["value"][0]["name"], "docs");
    assert_eq!(summary["tools"]["value"].as_array().unwrap().len(), 1);
    assert_eq!(summary["tools"]["value"][0]["server"], "docs");
    assert_eq!(summary["tools"]["value"][0]["definition"]["name"], "slow");
    assert_eq!(summary["resource"]["value"]["contents"][0]["text"], "slow");
    assert_eq!(summary["tool"]["value"]["isError"], false);
    assert_eq!(
        summary["ungranted"]["failure"], 1,
        "a server outside the grant must be rejected, not forwarded"
    );
    assert_eq!(summary["hidden_resource"]["failure"], 1);
    extension.shutdown().await;
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn denied_mcp_permission_hides_the_server_and_rejects_every_operation() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let service = service(&fixture);
    let extension = start(
        &fixture,
        "mcp_calls",
        &registry,
        Host {
            mcp: Some(service.clone()),
            ..Host::default()
        },
    )
    .await;
    fixture.deny("extension.mcp", "docs");
    let summary = summary(&fixture, &registry).await;
    assert_eq!(summary["servers"]["value"], json!([]));
    assert_eq!(summary["tools"]["value"], json!([]));
    for operation in ["resource", "tool", "ungranted", "hidden_resource"] {
        assert_eq!(summary[operation]["failure"], 1, "{operation}");
    }
    extension.shutdown().await;
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn mcp_calls_without_a_host_service_are_rejected_without_closing_the_generation() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "mcp_calls", &registry, Host::default()).await;
    let summary = summary(&fixture, &registry).await;
    for operation in [
        "servers",
        "tools",
        "resource",
        "tool",
        "ungranted",
        "hidden_resource",
    ] {
        assert_eq!(summary[operation]["failure"], 1, "{operation}");
    }
    extension.shutdown().await;
    fixture.cleanup();
}

#[tokio::test]
async fn unowned_duplicate_and_stale_host_calls_close_and_revoke_the_generation() {
    for mode in [
        "mcp_unowned_call",
        "mcp_relabelled_call",
        "mcp_duplicate_request",
        "mcp_after_result",
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let extension = start(&fixture, mode, &registry, Host::default()).await;
        if mode != "mcp_unowned_call" {
            let settled = registry
                .materialize(&[])
                .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
                .await;
            match mode {
                "mcp_after_result" => assert!(settled.is_ok_and(|result| result.error.is_none())),
                _ => assert!(
                    settled.as_ref().is_err() || settled.is_ok_and(|result| result.error.is_some()),
                    "{mode}: the affected call must fail visibly"
                ),
            }
        }
        tokio::time::timeout(Duration::from_secs(3), extension.closed())
            .await
            .unwrap_or_else(|_| panic!("{mode}: the generation must close"));
        assert!(registry.materialize(&[]).definitions.is_empty(), "{mode}");
        assert_eq!(
            extension.diagnostics().last(),
            Some(&v5::DiagnosticCode::ProtocolRejected),
            "{mode}"
        );
        extension.shutdown().await;
        fixture.cleanup();
    }
}

async fn cancelled_on_first_progress(
    fixture: &ToolFixture,
    registry: &ycoding_core::tools::registry::Registry,
) -> bool {
    let mut context = fixture.context();
    let token = context.cancellation.clone();
    context.progress = Some(Arc::new(move |_| {
        token.cancel();
        Box::pin(async {})
    }));
    let settled = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), context)
        .await;
    settled.is_err() || settled.is_ok_and(|result| result.error.is_some())
}

#[tokio::test]
async fn cancelling_the_parent_cancels_nested_mcp_calls_and_drops_their_replies() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let service = service(&fixture);
    service.tools().await.unwrap();
    let extension = start(
        &fixture,
        "mcp_cancel",
        &registry,
        Host {
            mcp: Some(service.clone()),
            ..Host::default()
        },
    )
    .await;
    assert!(cancelled_on_first_progress(&fixture, &registry).await);
    service
        .call_tool("docs", "slow", json!({}), None)
        .await
        .unwrap();
    extension.shutdown().await;
    assert!(
        !fixture.root.join("reply-after-cancel").exists(),
        "a cancelled parent must not receive its nested call's reply"
    );
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn host_calls_for_a_cancelling_parent_close_the_generation() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(
        &fixture,
        "mcp_call_while_cancelling",
        &registry,
        Host::default(),
    )
    .await;
    assert!(cancelled_on_first_progress(&fixture, &registry).await);
    tokio::time::timeout(Duration::from_secs(3), extension.closed())
        .await
        .unwrap();
    assert_eq!(
        extension.diagnostics().last(),
        Some(&v5::DiagnosticCode::ProtocolRejected)
    );
    extension.shutdown().await;
    fixture.cleanup();
}

#[tokio::test]
async fn at_most_eight_host_calls_run_at_once_and_the_rest_are_rejected() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let service = service(&fixture);
    service.tools().await.unwrap();
    let extension = start(
        &fixture,
        "mcp_flood",
        &registry,
        Host {
            mcp: Some(service.clone()),
            ..Host::default()
        },
    )
    .await;
    let summary = summary(&fixture, &registry).await;
    assert_eq!(summary["accepted"], 8);
    assert_eq!(summary["rejected"], 1);
    extension.shutdown().await;
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

#[tokio::test]
async fn results_beyond_the_frame_bound_are_rejected_without_closing_the_generation() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let server = json!({"type":"local","command":["/usr/bin/python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_oversized.py")]});
    let entries = [Entry::Document {
        path: None,
        info: parse_json(&json!({"mcp":{"servers":{"docs":server}}}).to_string()).unwrap(),
    }];
    let service = Arc::new(
        Service::new(
            &entries,
            fixture.root.clone(),
            "1".into(),
            BTreeMap::new(),
            Hooks::default(),
        )
        .unwrap(),
    );
    let extension = start(
        &fixture,
        "mcp_oversized",
        &registry,
        Host {
            mcp: Some(service.clone()),
            ..Host::default()
        },
    )
    .await;
    let summary = summary(&fixture, &registry).await;
    assert_eq!(summary["small"]["value"]["isError"], false);
    assert_eq!(
        summary["big"]["failure"], 2,
        "a result that cannot fit one frame is a categorical execution failure"
    );
    assert_eq!(
        summary["after"]["value"]["isError"], false,
        "the generation keeps serving calls"
    );
    extension.shutdown().await;
    service.shutdown().await.unwrap();
    fixture.cleanup();
}

#[test]
fn mcp_grants_load_as_a_family() {
    let fixture = ToolFixture::new();
    let content = r#"{"extensions":[{"identity":"fixture","executable":"/usr/bin/python3","grants":[{"family":"mcp","scopes":["docs"],"action":"extension.mcp","resources":["docs"]}]}]}"#;
    let configuration = ycoding_core::resources::config::Configuration::load(
        ycoding_core::resources::config::LoadOptions {
            directory: fixture.root.clone(),
            roots: ycoding_core::resources::config::Roots::development(&fixture.root).unwrap(),
            project: false,
            file: None,
            content: Some(content.into()),
            env: Default::default(),
        },
    )
    .unwrap();
    let loaded = Configuration::load(&configuration, fixture.root.clone()).unwrap();
    assert_eq!(loaded[0].families[0].family, v5::CapabilityFamily::Mcp);
    assert_eq!(loaded[0].families[0].scopes, ["docs"]);
    fixture.cleanup();
}
