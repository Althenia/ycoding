include!("tool_fixture.rs");
use std::{sync::Arc, time::Duration};
use ycoding_core::extension::{
    Configuration, Error, Extension, Host, Launch, Options, ToolGrant, v5,
};
use ycoding_schema::{JsonObject, JsonValue};

fn configuration(fixture: &ToolFixture, mode: &str) -> Configuration {
    Configuration {
        identity: "fixture".into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            mode.into(),
        ],
        directory: fixture.root.clone(),
        registration_order: 4,
        families: vec![],
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
    }
}
fn options() -> Options {
    Options {
        startup: Duration::from_millis(500),
        execution: Duration::from_millis(500),
        cleanup: Duration::from_millis(200),
        shutdown: Duration::from_millis(200),
        write: Duration::from_millis(500),
    }
}
async fn start(
    fixture: &ToolFixture,
    mode: &str,
    registry: &ycoding_core::tools::registry::Registry,
) -> Result<Extension, Error> {
    Extension::start(
        configuration(fixture, mode),
        options(),
        registry,
        fixture.policy.clone(),
        &ycoding_core::extension::Launch::default(),
        Host::default(),
    )
    .await
}
fn input() -> JsonValue {
    JsonValue::Object(JsonObject::new())
}

#[tokio::test]
async fn real_child_tool_materializes_direct_and_code_mode_validates_bounds_and_reports_progress() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "large_output", &registry).await.unwrap();
    let materialized = registry.materialize(&[]);
    assert_eq!(
        materialized
            .definitions
            .iter()
            .map(|tool| tool.name.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["demo_echo", "execute"]
    );
    let mut context = fixture.context();
    let (send, mut progress) = tokio::sync::mpsc::channel(1);
    context.progress = Some(Arc::new(move |update| {
        let send = send.clone();
        Box::pin(async move {
            send.send(update).await.unwrap();
        })
    }));
    let invalid = materialized
        .invoke("demo_echo", JsonValue::Null, context.clone())
        .await
        .unwrap();
    assert!(invalid.error.is_some());
    let settled = materialized
        .invoke("demo_echo", input(), context)
        .await
        .unwrap();
    assert_eq!(settled.output.as_ref().unwrap().structured, input());
    assert!(
        !settled.output_paths.is_empty(),
        "normal output-store bounding must retain large child output"
    );
    assert!(progress.recv().await.is_some());
    let pid = extension.pid();
    extension.shutdown().await;
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
    assert!(registry.materialize(&[]).definitions.is_empty());
    let stale = materialized
        .invoke("demo_echo", input(), fixture.context())
        .await
        .unwrap();
    assert!(stale.error.is_some());
    fixture.cleanup();
}

#[tokio::test]
async fn startup_negotiation_and_framing_fail_before_registration() {
    for (mode, expected) in [
        ("mismatch", Error::Negotiation),
        ("malformed", Error::Protocol),
        ("truncated", Error::Protocol),
        ("oversized", Error::Protocol),
        ("startup_timeout", Error::Timeout),
        ("unauthorized", Error::Unauthorized),
        ("duplicate_registration", Error::Unauthorized),
        ("bad_schema", Error::Schema),
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        assert_eq!(
            start(&fixture, mode, &registry).await.err(),
            Some(expected),
            "{mode}"
        );
        assert!(registry.materialize(&[]).definitions.is_empty(), "{mode}");
        let pid = std::fs::read_to_string(fixture.root.join("extension-child.pid"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(
            !ycoding_core::platform::process::is_alive(pid).unwrap(),
            "{mode} must reap failed startup"
        );
        fixture.cleanup();
    }
}

#[tokio::test]
async fn crash_timeout_stale_duplicate_and_unknown_settlement_never_replay() {
    for mode in [
        "crash",
        "timeout",
        "stale",
        "wrong_call",
        "unknown",
        "duplicate",
        "invalid_output",
        "failure",
        "malformed_call",
        "truncated_call",
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let extension = start(&fixture, mode, &registry).await.unwrap();
        let materialized = registry.materialize(&[]);
        let result = materialized
            .invoke("demo_echo", input(), fixture.context())
            .await
            .unwrap();
        if mode == "duplicate" {
            assert!(result.error.is_none());
        } else {
            assert!(result.error.is_some(), "{mode}");
        }
        if ["crash", "stale", "wrong_call", "unknown"].contains(&mode) {
            assert_eq!(
                result.error.as_ref().unwrap().r#type.as_str(),
                Some("extension.unknown_outcome"),
                "{mode}"
            );
        }
        let repeated = materialized
            .invoke("demo_echo", input(), fixture.context())
            .await
            .unwrap();
        assert!(
            repeated.error.is_some(),
            "same call identity must never replay: {mode}"
        );
        if [
            "duplicate",
            "stale",
            "wrong_call",
            "malformed_call",
            "truncated_call",
        ]
        .contains(&mode)
        {
            tokio::time::timeout(Duration::from_secs(2), extension.closed())
                .await
                .unwrap();
            assert!(registry.materialize(&[]).definitions.is_empty());
            assert!(
                extension
                    .diagnostics()
                    .contains(&v5::DiagnosticCode::ProtocolRejected)
            );
        }
        let pid = extension.pid();
        extension.shutdown().await;
        assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
        assert!(registry.materialize(&[]).definitions.is_empty());
        fixture.cleanup();
    }
}

#[tokio::test]
async fn unsolicited_frames_and_dropped_calls_revoke_and_reap() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "unsolicited", &registry).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), extension.closed())
        .await
        .unwrap();
    assert!(!ycoding_core::platform::process::is_alive(extension.pid()).unwrap());
    assert!(registry.materialize(&[]).definitions.is_empty());
    extension.shutdown().await;
    fixture.cleanup();
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "cancel_ignore", &registry).await.unwrap();
    let materialized = registry.materialize(&[]);
    let mut context = fixture.context();
    let (send, mut started) = tokio::sync::mpsc::channel(1);
    context.progress = Some(Arc::new(move |update| {
        let send = send.clone();
        Box::pin(async move {
            send.send(update).await.unwrap();
        })
    }));
    let invoke =
        tokio::spawn(async move { materialized.invoke("demo_echo", input(), context).await });
    started.recv().await.unwrap();
    invoke.abort();
    assert!(invoke.await.unwrap_err().is_cancelled());
    tokio::time::timeout(Duration::from_secs(2), extension.closed())
        .await
        .unwrap();
    assert!(!ycoding_core::platform::process::is_alive(extension.pid()).unwrap());
    extension.shutdown().await;
    fixture.cleanup();
}

#[test]
fn resolved_configuration_rejects_obsolete_plugins_and_provider_packages() {
    for content in [
        r#"{"plugins":["npm:old"]}"#,
        r#"{"providers":{"custom":{"package":"old"}}}"#,
        r#"{"extensions":[{"identity":"x","executable":"relative"}]}"#,
    ] {
        let fixture = ToolFixture::new();
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
        assert!(Configuration::load(&configuration, fixture.root.clone()).is_err());
        fixture.cleanup();
    }
    let fixture = ToolFixture::new();
    let content = r#"{"extensions":[{"identity":"fixture","executable":"/usr/bin/python3","args":[],"grants":[{"family":"tools","namespace":"demo","tools":["echo"],"action":"extension.echo","resources":["demo"]}]}]}"#;
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
    let resolved = Configuration::load(&configuration, fixture.root.clone()).unwrap();
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].identity, "fixture");
    assert_eq!(resolved[0].grants[0].action, "extension.echo");
    fixture.cleanup();
}

#[tokio::test]
async fn cancellation_settles_after_cleanup_or_forced_reaping_and_replacement_revokes_held_tools() {
    for mode in ["cancel", "cancel_ignore"] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let extension = start(&fixture, mode, &registry).await.unwrap();
        let materialized = registry.materialize(&[]);
        let mut context = fixture.context();
        let (send, mut started) = tokio::sync::mpsc::channel(1);
        context.progress = Some(Arc::new(move |update| {
            let send = send.clone();
            Box::pin(async move {
                send.send(update).await.unwrap();
            })
        }));
        let cancellation = context.cancellation.clone();
        let invoke =
            tokio::spawn(async move { materialized.invoke("demo_echo", input(), context).await });
        started.recv().await.unwrap();
        cancellation.cancel();
        assert!(matches!(
            invoke.await.unwrap(),
            Err(ycoding_core::tools::materialization::Error::Execution(
                ycoding_core::tools::registry::Failure::Cancelled
            ))
        ));
        if mode == "cancel_ignore" {
            assert!(!ycoding_core::platform::process::is_alive(extension.pid()).unwrap());
        }
        extension.shutdown().await;
        fixture.cleanup();
    }
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let old = start(&fixture, "ok", &registry).await.unwrap();
    let held = registry.materialize(&[]);
    let new = old
        .replace(
            configuration(&fixture, "ok"),
            options(),
            &registry,
            fixture.policy.clone(),
            &ycoding_core::extension::Launch::default(),
            Host::default(),
        )
        .await
        .unwrap();
    assert_ne!(old.generation, new.generation);
    assert!(!ycoding_core::platform::process::is_alive(old.pid()).unwrap());
    assert!(
        held.invoke("demo_echo", input(), fixture.context())
            .await
            .unwrap()
            .error
            .is_some()
    );
    assert!(
        registry
            .materialize(&[])
            .invoke("demo_echo", input(), fixture.context())
            .await
            .unwrap()
            .error
            .is_none()
    );
    let context = ycoding_core::tools::context::Context::new(
        "ses_tool",
        "test",
        "msg_tool",
        "call_code_mode",
    )
    .unwrap();
    let code_mode = registry
        .materialize(&[])
        .invoke(
            "execute",
            ycoding_schema::parse_json(r#"{"code":"return await tools.demo.echo({})"}"#).unwrap(),
            context,
        )
        .await
        .unwrap();
    assert!(code_mode.error.is_none());
    assert_eq!(
        code_mode.output.unwrap().structured,
        ycoding_schema::parse_json(r#"{"toolCalls":[{"tool":"demo.echo","status":"completed"}]}"#)
            .unwrap()
    );
    new.shutdown().await;
    fixture.cleanup();
}

#[tokio::test]
async fn captured_leaf_authority_diagnostics_and_bounded_stop() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "secret", &registry).await.unwrap();
    fixture.deny("extension.echo", "*");
    let rejected = registry
        .materialize(&[])
        .invoke("demo_echo", input(), fixture.context())
        .await
        .unwrap();
    assert!(rejected.error.is_some());
    extension.shutdown().await;
    let diagnostics = extension.diagnostics();
    assert!(diagnostics.contains(&v5::DiagnosticCode::StderrDiscarded));
    assert!(!format!("{diagnostics:?}").contains("SYNTHETIC_SECRET"));
    let launch = |action: &str, effect: &str| Launch {
        rules: vec![ycoding_schema::permission::Rule {
            action: action.into(),
            resource: "*".into(),
            effect: ycoding_schema::permission::Effect(effect.into()),
        }],
        ..Default::default()
    };
    for (effect, expected) in [("deny", Error::Permission), ("ask", Error::ApprovalUnavailable)] {
        assert_eq!(
            Extension::start(
                configuration(&fixture, "ok"),
                options(),
                &registry,
                fixture.policy.clone(),
                &launch("extension.launch", effect),
                Host::default(),
            )
            .await
            .err(),
            Some(expected),
            "a configured {effect} rule fails closed at Location launch"
        );
    }
    let cancelled = Launch::default();
    cancelled.cancellation.cancel();
    assert_eq!(
        Extension::start(
            configuration(&fixture, "ok"),
            options(),
            &registry,
            fixture.policy.clone(),
            &cancelled,
            Host::default(),
        )
        .await
        .err(),
        Some(Error::Cancelled)
    );
    let unmatched = Extension::start(
        configuration(&fixture, "ok"),
        options(),
        &registry,
        fixture.policy.clone(),
        &launch("extension.other", "deny"),
        Host::default(),
    )
    .await
    .expect("configuration trust launches when no rule matches");
    unmatched.shutdown().await;
    fixture.cleanup();
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "shutdown_ignore", &registry).await.unwrap();
    let pid = extension.pid();
    tokio::time::timeout(Duration::from_secs(2), extension.shutdown())
        .await
        .unwrap();
    assert!(!ycoding_core::platform::process::is_alive(pid).unwrap());
    fixture.cleanup();
}
