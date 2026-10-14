include!("tool_fixture.rs");
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use tracing::instrument::WithSubscriber;
use ycoding_core::extension::{Error, Extension, FamilyGrant, Host, Launch, Resources, v5};
use ycoding_core::resources::{agent, catalog, command, reference, skill};
use ycoding_schema::{DomainEncode, parse_json, stringify_json};

#[path = "extension_contract_support/mod.rs"]
mod support;
use support::{family, options};

const WATCHDOG: Duration = Duration::from_secs(30);

#[test]
fn extension_channel_is_core_owned_and_separate_from_application_wire() {
    let source = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../protocol/ycoding/extension/v5/extension.proto"
    ))
    .expect("Core must own a canonical extension channel descriptor");
    assert!(source.contains("package ycoding.extension.v5;"));
    assert!(!source.contains("import "));
    for message in [
        "HostFrame",
        "ChildFrame",
        "Hello",
        "Ready",
        "RegisterTools",
        "Execute",
        "Result",
        "Progress",
        "Cancel",
        "Cleanup",
        "Shutdown",
        "Diagnostic",
        "SessionCreate",
        "SessionGenerate",
        "SessionCommand",
        "SessionSynthetic",
    ] {
        assert!(
            source.contains(&format!("message {message} {{")),
            "{message}"
        );
    }
}

#[test]
fn session_host_call_additions_use_the_next_tags_and_generated_strict_rules() {
    use prost::Message;
    use ycoding_core::extension::wire;
    let call = v5::Call {
        invocation: 1,
        session_id: "ses_one".into(),
        message_id: "msg_one".into(),
        call_id: wire::text(&"call_one".into()),
        agent: "test".into(),
    };
    let prefix = v5::HostCall {
        call: call.clone(),
        request: 1,
        operation: None,
    }
    .encode_to_vec();
    for (tag, operation) in [
        (
            10,
            v5::host_call::Operation::SessionCreate(v5::SessionCreate::default()),
        ),
        (
            11,
            v5::host_call::Operation::SessionGenerate(v5::SessionGenerate {
                session: "ses_one".into(),
                prompt: wire::text(&"Generate".into()),
            }),
        ),
        (
            12,
            v5::host_call::Operation::SessionCommand(v5::SessionCommand {
                session: "ses_one".into(),
                message: "msg_one".into(),
                command: wire::text(&"test".into()),
                arguments: wire::text(&"".into()),
                input: wire::value(&ycoding_schema::JsonValue::Null),
                agent: None,
                model: None,
                resume: Some(false),
            }),
        ),
        (
            13,
            v5::host_call::Operation::SessionSynthetic(v5::SessionSynthetic {
                session: "ses_one".into(),
                message: "msg_one".into(),
                input: wire::value(&ycoding_schema::JsonValue::Null),
                resume: Some(false),
            }),
        ),
    ] {
        let host = v5::HostCall {
            call: call.clone(),
            request: 1,
            operation: Some(operation),
        };
        let bytes = host.encode_to_vec();
        assert_eq!(&bytes[..prefix.len()], prefix.as_slice());
        assert_eq!(bytes[prefix.len()], (tag << 3) | 2);
        assert_eq!(
            wire::decode::<v5::HostCall>(&bytes, ".ycoding.extension.v5.HostCall").unwrap(),
            host
        );
    }
}

fn all_hooks() -> FamilyGrant {
    family(
        v5::CapabilityFamily::Hooks,
        &[
            "session.context",
            "tool.execute.before",
            "tool.execute.after",
        ],
    )
}

fn invoke_input() -> ycoding_schema::JsonValue {
    parse_json("{}").unwrap()
}

fn unknown_outcome(settlement: &ycoding_core::tools::materialization::Settlement) -> bool {
    settlement
        .error
        .as_ref()
        .is_some_and(|error| error.r#type.as_str() == Some("extension.unknown_outcome"))
}

async fn invoke(
    registry: &ycoding_core::tools::registry::Registry,
    context: ycoding_core::tools::context::Context,
) -> Result<
    ycoding_core::tools::materialization::Settlement,
    ycoding_core::tools::materialization::Error,
> {
    registry
        .materialize(&[])
        .invoke("demo_echo", invoke_input(), context)
        .await
}

// TEST-043: invalid, duplicate and ungranted registration per family installs nothing.
#[tokio::test]
async fn invalid_duplicate_and_ungranted_registrations_install_nothing_and_reap_the_child() {
    let agent_value = |id: &str| -> Value {
        serde_json::from_str(&stringify_json(&agent::empty(id.into()).encode())).unwrap()
    };
    let hook = json!([{"id": "h", "stage": 7}]);
    let transform = json!([{"id": "t", "stage": 1}]);
    let domain = |key: &str, value: Value| json!([{"domain": 1, "key": key, "value": value}]);
    let cases = [
        (
            "hook_scope_not_granted",
            json!({"transforms": hook}),
            vec![family(v5::CapabilityFamily::Hooks, &["session.context"])],
            Error::Unauthorized,
        ),
        (
            "transform_scope_not_granted",
            json!({"transforms": transform}),
            vec![family(v5::CapabilityFamily::Transforms, &["commands"])],
            Error::Unauthorized,
        ),
        (
            "transform_family_not_granted",
            json!({"transforms": transform}),
            vec![],
            Error::Unauthorized,
        ),
        (
            "transform_id_duplicate",
            json!({"transforms": [{"id": "h", "stage": 7}, {"id": "h", "stage": 8}]}),
            vec![all_hooks()],
            Error::Protocol,
        ),
        (
            "transform_stage_unknown",
            json!({"transforms": [{"id": "h", "stage": 99}]}),
            vec![all_hooks()],
            Error::Protocol,
        ),
        (
            "domain_family_not_granted",
            json!({"domains": domain("alpha", agent_value("alpha"))}),
            vec![],
            Error::Unauthorized,
        ),
        (
            "domain_key_mismatch",
            json!({"domains": domain("beta", agent_value("alpha"))}),
            vec![family(v5::CapabilityFamily::Registrations, &["agents"])],
            Error::Unauthorized,
        ),
        (
            "domain_undecodable",
            json!({"domains": domain("alpha", json!({}))}),
            vec![family(v5::CapabilityFamily::Registrations, &["agents"])],
            Error::Schema,
        ),
        (
            "domain_duplicate",
            json!({"domains": [
                {"domain": 1, "key": "alpha", "value": agent_value("alpha")},
                {"domain": 1, "key": "alpha", "value": agent_value("alpha")}
            ]}),
            vec![family(v5::CapabilityFamily::Registrations, &["agents"])],
            Error::Protocol,
        ),
        (
            "subscription_family_not_granted",
            json!({"subscriptions": [{"id": 1, "families": ["agent.updated"]}]}),
            vec![family(v5::CapabilityFamily::Events, &["command.updated"])],
            Error::Unauthorized,
        ),
    ];
    for (name, spec, families, expected) in cases {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let result = Extension::start(
            support::configuration(&fixture.root, name, spec, families),
            options(),
            &registry,
            fixture.policy.clone(),
            &Launch::default(),
            Host::default(),
        )
        .await;
        assert_eq!(result.err(), Some(expected), "{name}");
        assert!(
            registry.materialize(&[]).definitions.is_empty(),
            "{name}: the valid tool declared in the same batch must not install"
        );
        let pid = std::fs::read_to_string(fixture.root.join(format!("{name}.evidence.pid")))
            .unwrap()
            .parse()
            .unwrap();
        support::gone(name, &[pid]).await;
        fixture.cleanup();
    }
}

struct Seed {
    resources: Resources,
}

fn seed(fixture: &ToolFixture, skills: bool) -> Seed {
    let mut sources = skill::Service::new(&fixture.root.join("cache"));
    if skills {
        sources.source(
            ycoding_schema::skill::Source::decode(&parse_json(r#"{"type":"embedded","skill":{"id":"base","name":"Base","location":"/builtin/base.md","content":"body"}}"#).unwrap()).unwrap(),
        );
    }
    Seed {
        resources: Resources {
            agents: agent::Service::new(vec![
                agent::empty("alpha".into()),
                agent::empty("beta".into()),
            ]),
            commands: command::Service::default(),
            references: reference::Service::from_infos(vec![]),
            skills: sources,
            catalog: catalog::Catalog::default(),
        },
    }
}

fn agent_ids(service: &agent::Service) -> Vec<String> {
    let mut ids = service
        .list()
        .iter()
        .map(|agent| agent.id.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn watch(resources: &Resources, fixture: &ToolFixture) -> ycoding_core::event_feed::Subscriber {
    let feed = ycoding_core::event_feed::Feed::attach(&fixture.authority.store.client());
    let location = ycoding_schema::location::Ref::decode(
        &parse_json(&format!(
            r#"{{"directory":{}}}"#,
            stringify_json(&ycoding_schema::JsonValue::String(
                fixture.root.to_str().unwrap().into()
            ))
        ))
        .unwrap(),
    )
    .unwrap();
    for source in [
        &resources.agents.event_source,
        &resources.skills.event_source,
    ] {
        source.bind(feed.clone(), Some(location.clone())).unwrap();
    }
    feed.subscribe(ycoding_core::event_feed::Scope::Global, None, || {})
        .unwrap()
}

use ycoding_schema::DomainDecode;

// TEST-043 family row "transforms": ordered remove/add/default edits are reflected in the real
// agent service; a rejected draft leaves the previous complete generation and its events alone.
#[tokio::test]
async fn transform_edits_reach_discovery_and_rejected_drafts_leave_prior_resources_unchanged() {
    let transforms = family(
        v5::CapabilityFamily::Transforms,
        &["agents", "skills", "commands"],
    );
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let base = seed(&fixture, true).resources;
    let updates = watch(&base, &fixture);
    let extension = support::start(
        &fixture.root,
        "edits",
        support::configuration(
            &fixture.root,
            "edits",
            json!({"transforms": [{"id": "agents", "stage": 1}], "edits": {"1": [
                {"op": "remove", "id": "alpha"},
                {"op": "copy", "from": "beta", "id": "gamma"},
                {"op": "default", "id": "gamma"}
            ]}}),
            vec![transforms.clone()],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .await;
    let edited = base
        .materialize(&[&extension], &fixture.context())
        .await
        .unwrap();
    assert_eq!(agent_ids(&edited.agents), ["beta", "gamma"]);
    assert_eq!(
        edited.agents.default_id().map(|id| id.as_str().unwrap()),
        Some("gamma")
    );
    assert!(edited.agents.get(&"alpha".into()).is_none());
    assert_eq!(agent_ids(&base.agents), ["alpha", "beta"]);
    let mut published = Vec::new();
    while let Some(item) = updates.next().unwrap() {
        let ycoding_core::event_feed::Payload::Ephemeral(event) = &item.payload else {
            panic!("resource update is ephemeral");
        };
        published.push(event.data.name());
    }
    assert_eq!(published, ["agent.updated"]);
    extension.shutdown().await;
    assert_eq!(
        agent_ids(
            &base
                .materialize(&[&extension], &fixture.context())
                .await
                .unwrap()
                .agents
        ),
        ["alpha", "beta"],
        "a closed generation contributes no edits"
    );
    fixture.cleanup();

    for (name, stage, edit, expected) in [
        (
            "duplicate_agent",
            1,
            json!({"op": "duplicate_first"}),
            Error::Schema,
        ),
        (
            "overflow",
            1,
            json!({"op": "overflow"}),
            Error::UnknownOutcome,
        ),
        ("undecodable", 1, json!({"op": "garbage"}), Error::Schema),
        (
            "skill_source_removed",
            4,
            json!({"op": "clear"}),
            Error::Unauthorized,
        ),
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let base = seed(&fixture, true).resources;
        let updates = watch(&base, &fixture);
        let extension = support::start(
            &fixture.root,
            name,
            support::configuration(
                &fixture.root,
                name,
                json!({"transforms": [{"id": "stage", "stage": stage}], "edits": {stage.to_string(): [edit]}}),
                vec![transforms.clone()],
            ),
            &registry,
            fixture.policy.clone(),
            Host::default(),
            options(),
        )
        .await;
        assert_eq!(
            base.materialize(&[&extension], &fixture.context())
                .await
                .err(),
            Some(expected),
            "{name}"
        );
        assert_eq!(agent_ids(&base.agents), ["alpha", "beta"], "{name}");
        assert_eq!(base.skills.sources().len(), 1, "{name}");
        assert!(
            updates.next().unwrap().is_none(),
            "{name}: no partial publication"
        );
        extension.shutdown().await;
        fixture.cleanup();
    }
}

// TEST-043 cancellation/late settlement: a transform settles once, after cleanup or reaping.
#[tokio::test]
async fn cancelled_transforms_settle_once_after_cleanup_and_late_replies_close_the_generation() {
    let transforms = family(v5::CapabilityFamily::Transforms, &["agents"]);
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let base = seed(&fixture, false).resources;
    let extension = support::start(
        &fixture.root,
        "held",
        support::configuration(
            &fixture.root,
            "held",
            json!({"transforms": [{"id": "agents", "stage": 1}], "hold_transform": true, "cancel_reply": "cleanup"}),
            vec![transforms.clone()],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .await;
    let context = fixture.context();
    let token = context.cancellation.clone();
    let root = fixture.root.clone();
    let list = [&extension];
    let (settled, ()) = tokio::time::timeout(WATCHDOG, async {
        tokio::join!(base.materialize(&list, &context), async {
            support::marker(&root, "transform-held").await;
            token.cancel();
        })
    })
    .await
    .unwrap();
    assert_eq!(settled.err(), Some(Error::Cancelled));
    assert_eq!(
        agent_ids(
            &base
                .materialize(&[&extension], &fixture.context())
                .await
                .unwrap()
                .agents
        ),
        ["alpha", "beta"],
        "cleanup leaves the generation usable for the next transform"
    );
    extension.shutdown().await;
    fixture.cleanup();

    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let base = seed(&fixture, false).resources;
    let extension = support::start(
        &fixture.root,
        "late",
        support::configuration(
            &fixture.root,
            "late",
            json!({"transforms": [{"id": "agents", "stage": 1}], "hold_transform": true, "cancel_reply": "transformed"}),
            vec![transforms],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .await;
    let context = fixture.context();
    let token = context.cancellation.clone();
    let root = fixture.root.clone();
    let list = [&extension];
    let (settled, ()) = tokio::time::timeout(WATCHDOG, async {
        tokio::join!(base.materialize(&list, &context), async {
            support::marker(&root, "transform-held").await;
            token.cancel();
        })
    })
    .await
    .unwrap();
    assert_eq!(
        settled.err(),
        Some(Error::Cancelled),
        "a reply after Cancel is not Cleanup; the caller still settles once as cancelled"
    );
    tokio::time::timeout(WATCHDOG, extension.closed())
        .await
        .unwrap();
    assert!(
        extension
            .diagnostics()
            .contains(&v5::DiagnosticCode::ProtocolRejected)
    );
    support::gone(
        "late reply child",
        &[support::child_pid(&fixture.root, "late")],
    )
    .await;
    extension.shutdown().await;
    fixture.cleanup();
}

// TEST-043 family row "tool hooks": a failed or forged before hook has no effect; the control
// proves the same child does perform exactly one effect when the hook passes.
#[tokio::test]
async fn failed_before_hooks_run_no_effect_and_a_passing_hook_runs_exactly_one() {
    for (name, hook, effects) in [
        ("hook_fail", Some("fail"), 0),
        ("hook_rename", Some("rename"), 0),
        ("hook_pass", None, 1),
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let marker = fixture.root.join("effects");
        let mut spec = json!({"exec": "effect", "effects": marker, "transforms": [{"id": "before", "stage": 7}]});
        if let Some(hook) = hook {
            spec["hook7"] = hook.into();
        }
        let extension = support::start(
            &fixture.root,
            name,
            support::configuration(
                &fixture.root,
                name,
                spec,
                vec![family(
                    v5::CapabilityFamily::Hooks,
                    &["tool.execute.before"],
                )],
            ),
            &registry,
            fixture.policy.clone(),
            Host::default(),
            options(),
        )
        .await;
        let settled = invoke(&registry, fixture.context()).await;
        match (hook, settled) {
            (Some(_), Ok(settlement)) => assert!(settlement.error.is_some(), "{name}"),
            (Some(_), Err(_)) => {}
            (None, settlement) => assert!(settlement.unwrap().error.is_none(), "{name}"),
        }
        assert_eq!(support::lines(&marker), effects, "{name}");
        extension.shutdown().await;
        fixture.cleanup();
    }
}

// TEST-043 Execute row: crash after the effect is an unknown outcome and is never replayed.
#[tokio::test]
async fn crash_or_exit_after_an_effect_is_unknown_and_never_replayed_or_restarted() {
    for mode in ["effect_crash", "effect_exit"] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let marker = fixture.root.join("effects");
        let extension = support::start(
            &fixture.root,
            mode,
            support::configuration(
                &fixture.root,
                mode,
                json!({"exec": mode, "effects": marker, "grandchild": true, "pidfile": fixture.root.join(format!("{mode}.pids"))}),
                vec![],
            ),
            &registry,
            fixture.policy.clone(),
            Host::default(),
            options(),
        )
        .await;
        let first = invoke(&registry, fixture.context()).await.unwrap();
        assert!(unknown_outcome(&first), "{mode}: {:?}", first.error);
        assert_eq!(support::lines(&marker), 1, "{mode}");
        let again = invoke(&registry, fixture.context()).await;
        assert!(again.is_err() || again.unwrap().error.is_some(), "{mode}");
        let other = ycoding_core::tools::context::Context::new(
            "ses_tool",
            "test",
            "msg_tool",
            "call_after_crash",
        )
        .unwrap();
        let fresh = invoke(&registry, other).await;
        assert!(fresh.is_err() || fresh.unwrap().error.is_some(), "{mode}");
        assert_eq!(
            support::lines(&marker),
            1,
            "{mode}: neither the same nor a fresh call re-dispatches the effect"
        );
        tokio::time::timeout(WATCHDOG, extension.closed())
            .await
            .unwrap();
        assert!(registry.materialize(&[]).definitions.is_empty(), "{mode}");
        let (child, descendant) = support::pids(&fixture.root, mode);
        support::reap(descendant);
        assert!(!support::alive(child), "{mode}: child");
        extension.shutdown().await;
        fixture.cleanup();
    }
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let marker = fixture.root.join("effects");
    let extension = support::start(
        &fixture.root,
        "effect_once",
        support::configuration(
            &fixture.root,
            "effect_once",
            json!({"exec": "effect", "effects": marker}),
            vec![],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .await;
    assert!(
        invoke(&registry, fixture.context())
            .await
            .unwrap()
            .error
            .is_none()
    );
    assert_eq!(support::lines(&marker), 1);
    extension.shutdown().await;
    fixture.cleanup();
}

// TEST-043 stdio bounds: oversize, partial and flooded stdio fail closed without deadlock.
#[tokio::test]
async fn oversize_partial_and_flooded_stdio_fail_closed_and_stay_bounded() {
    for (name, spec, expected) in [
        (
            "oversize_in_call",
            json!({"exec": "oversize"}),
            v5::DiagnosticCode::ProtocolRejected,
        ),
        (
            "partial_in_call",
            json!({"exec": "partial_hang"}),
            v5::DiagnosticCode::DeadlineExceeded,
        ),
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let mut options = options();
        options.execution = Duration::from_millis(400);
        let extension = support::start(
            &fixture.root,
            name,
            support::configuration(&fixture.root, name, spec, vec![]),
            &registry,
            fixture.policy.clone(),
            Host::default(),
            options,
        )
        .await;
        let settled = tokio::time::timeout(WATCHDOG, invoke(&registry, fixture.context()))
            .await
            .unwrap();
        assert!(
            settled.is_err() || settled.unwrap().error.is_some(),
            "{name}: a transmitted call that cannot settle is visible"
        );
        tokio::time::timeout(WATCHDOG, extension.closed())
            .await
            .unwrap();
        assert!(extension.diagnostics().contains(&expected), "{name}");
        assert!(registry.materialize(&[]).definitions.is_empty(), "{name}");
        support::gone(name, &[extension.pid()]).await;
        extension.shutdown().await;
        fixture.cleanup();
    }

    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let result = Extension::start(
        support::configuration(
            &fixture.root,
            "oversize_after_ready",
            json!({"oversize_after_ready": true}),
            vec![],
        ),
        options(),
        &registry,
        fixture.policy.clone(),
        &Launch::default(),
        Host::default(),
    )
    .await;
    if let Ok(extension) = result {
        tokio::time::timeout(WATCHDOG, extension.closed())
            .await
            .unwrap();
        extension.shutdown().await;
    }
    assert!(registry.materialize(&[]).definitions.is_empty());
    support::gone(
        "oversize_after_ready",
        &[support::child_pid(&fixture.root, "oversize_after_ready")],
    )
    .await;
    fixture.cleanup();

    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let mut options = options();
    options.execution = Duration::from_secs(20);
    let extension = support::start(
        &fixture.root,
        "flood",
        support::configuration(
            &fixture.root,
            "flood",
            json!({"flood": 4 * 1024 * 1024, "exec": "big", "big_result": 700_000}),
            vec![],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options,
    )
    .await;
    let settled = tokio::time::timeout(WATCHDOG, invoke(&registry, fixture.context()))
        .await
        .expect("stderr pressure must not block the stdout frame")
        .unwrap();
    assert!(settled.error.is_none(), "{:?}", settled.error);
    let diagnostics = extension.diagnostics();
    assert!(diagnostics.len() <= 32);
    assert!(diagnostics.contains(&v5::DiagnosticCode::StderrDiscarded));
    assert!(!format!("{diagnostics:?}").contains("SSSS"));
    extension.shutdown().await;
    fixture.cleanup();
}

#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

impl Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// TEST-043 secret env: the host environment is observable by the (unsandboxed) child, but a
// sentinel there never reaches diagnostics, tool settlements or host logs. The sentinel is
// exported only to a re-executed copy of this test so the shared test process is not mutated.
#[tokio::test]
async fn secret_environment_stays_off_host_surfaces() {
    const SENTINEL: &str = "YCODING_CONTRACT_SENTINEL_VALUE";
    if std::env::var("YCODING_CONTRACT_SECRET").is_err() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "secret_environment_stays_off_host_surfaces",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("YCODING_CONTRACT_SECRET", SENTINEL)
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .finish();
    let subscriber = tracing::Dispatch::new(subscriber);
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = support::start(
        &fixture.root,
        "secret",
        support::configuration(
            &fixture.root,
            "secret",
            json!({"dump_env": ["YCODING_CONTRACT_SECRET"], "exec": "effect", "effects": fixture.root.join("effects")}),
            vec![],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .with_subscriber(subscriber.clone())
    .await;
    let settled = invoke(&registry, fixture.context())
        .with_subscriber(subscriber)
        .await
        .unwrap();
    extension.shutdown().await;
    let rendered = format!("{:?} {:?}", extension.diagnostics(), settled);
    assert!(!rendered.contains(SENTINEL), "{rendered}");
    assert!(
        extension
            .diagnostics()
            .contains(&v5::DiagnosticCode::StderrDiscarded),
        "the child did write to stderr"
    );
    let logged = String::from_utf8(logs.0.lock().unwrap().clone()).unwrap();
    assert!(!logged.contains(SENTINEL), "{logged}");
    fixture.cleanup();
}

// TEST-043 lifecycle: every stop path reaps the owned descendant tree, including a descendant
// that ignores SIGTERM.
#[tokio::test]
async fn owned_process_tree_is_gone_after_stop_kill_crash_cancel_and_drop() {
    let mut failures = Vec::new();
    for scenario in ["graceful", "ignored_shutdown", "cancelled", "dropped"] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let mut spec =
            json!({"grandchild": true, "pidfile": fixture.root.join(format!("{scenario}.pids"))});
        match scenario {
            "ignored_shutdown" => spec["ignore_shutdown"] = true.into(),
            "cancelled" => {
                spec["exec"] = "hold".into();
                spec["cancel_reply"] = "none".into();
            }
            _ => {}
        }
        let extension = support::start(
            &fixture.root,
            scenario,
            support::configuration(&fixture.root, scenario, spec, vec![]),
            &registry,
            fixture.policy.clone(),
            Host::default(),
            options(),
        )
        .await;
        support::marker(&fixture.root, &format!("{scenario}.pids")).await;
        let (child, descendant) = support::pids(&fixture.root, scenario);
        let _reaped = support::Reaper(descendant);
        assert!(support::alive(descendant), "{scenario}: premise");
        match scenario {
            "graceful" | "ignored_shutdown" => {
                tokio::time::timeout(WATCHDOG, extension.shutdown())
                    .await
                    .unwrap();
                failures.extend(tree_failures(scenario, child, None));
            }
            "cancelled" => {
                let context = fixture.context();
                let token = context.cancellation.clone();
                let materialized = registry.materialize(&[]);
                let call = tokio::spawn(async move {
                    materialized
                        .invoke("demo_echo", invoke_input(), context)
                        .await
                });
                tokio::time::sleep(Duration::from_millis(300)).await;
                token.cancel();
                assert!(matches!(
                    tokio::time::timeout(WATCHDOG, call).await.unwrap().unwrap(),
                    Err(ycoding_core::tools::materialization::Error::Execution(
                        ycoding_core::tools::registry::Failure::Cancelled
                    ))
                ));
                failures.extend(tree_failures(scenario, child, Some(descendant)));
                extension.shutdown().await;
            }
            _ => {
                drop(extension);
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while std::time::Instant::now() < deadline && support::alive(child) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                failures.extend(tree_failures(scenario, child, None));
            }
        }
        fixture.cleanup();
    }
    assert!(failures.is_empty(), "{failures:?}");
}

fn tree_failures(scenario: &str, child: u32, descendant: Option<u32>) -> Vec<String> {
    [
        Some(("child", child)),
        descendant.map(|pid| ("descendant", pid)),
    ]
    .into_iter()
    .flatten()
    .filter(|(_, pid)| support::alive(*pid))
    .map(|(role, pid)| format!("{scenario}: {role} {pid} still alive"))
    .collect()
}

fn provider_info(package: &str) -> ycoding_schema::model::Info {
    let mut model = ycoding_core::resources::catalog::models_dev::normalize(
        &parse_json(include_str!(
            "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
        ))
        .unwrap(),
    )
    .unwrap()[0]
        .models[0]
        .clone();
    model.package = Some(package.into());
    model.model_id = "fake-model".into();
    model.provider_id = ycoding_schema::provider::Id("fixture".into());
    model.settings = Some(
        ycoding_schema::provider::Settings::decode(
            &parse_json(r#"{"baseURL":"http://127.0.0.1:1","apiKey":"fixture"}"#).unwrap(),
        )
        .unwrap(),
    );
    model
}

async fn provider_attempt(package: &str) -> Result<ycoding_ai::llm::Response, ycoding_ai::Error> {
    let model =
        ycoding_core::resources::model::from_catalog_model(&provider_info(package), None).unwrap();
    assert!(matches!(
        model.route.transport,
        ycoding_ai::route::Transport::Process(_)
    ));
    let mut request = ycoding_ai::llm::Request::new(model);
    request.messages = vec![ycoding_ai::llm::Message::user("hi")];
    request.caller = Some(ycoding_ai::llm::Caller {
        session_id: "ses_tool".into(),
        agent: "test".into(),
        message_id: "msg_tool".into(),
    });
    ycoding_ai::route::Executor::new(ycoding_ai::route::Executor::http_client().unwrap())
        .generate(&request)
        .await
}

const PROVIDER: &str = "aisdk:@ycoding-ai/ai/providers/openai-compatible";
const MALFORMED_PROVIDER: &str = "aisdk:@openrouter/ai-sdk-provider";

// TEST-043 provider row: replies match by host request identity, failure codes keep their
// category, Rust performs one physical request per attempt, and usage is reported once.
#[tokio::test]
async fn provider_attempts_match_replies_by_request_and_never_retry_in_the_child_boundary() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let log = fixture.root.join("provider.log");
    let extension = support::start(
        &fixture.root,
        "provider",
        support::configuration(
            &fixture.root,
            "provider",
            json!({"provider": {"log": log, "outcomes": ["stray", "reject", "exec", "unknown", "ok"]}}),
            vec![family(v5::CapabilityFamily::Providers, &[PROVIDER])],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .await;
    let first = provider_attempt(PROVIDER).await.unwrap();
    assert_eq!(first.text().as_str(), Some("Hello"));
    let usage = first.usage.as_ref().expect("usage");
    assert_eq!(
        (usage.input_tokens, usage.output_tokens, usage.total_tokens),
        (Some(10.0), Some(20.0), Some(30.0)),
        "usage reflects the single child reply, not the stray result"
    );
    for (outcome, category) in [
        ("reject", "rejected"),
        ("exec", "failed"),
        ("unknown", "replay prohibited"),
    ] {
        let error = format!("{:?}", provider_attempt(PROVIDER).await.unwrap_err());
        assert!(error.contains(category), "{outcome}: {error}");
    }
    assert_eq!(
        provider_attempt(PROVIDER).await.unwrap().text().as_str(),
        Some("Hello"),
        "failed attempts leave the generation usable"
    );
    assert_eq!(
        support::lines(&log),
        5,
        "one ProviderRequest per physical attempt; failures are not retried here"
    );
    let other = "aisdk:@ycoding-ai/ai/providers/openai";
    let model =
        ycoding_core::resources::model::from_catalog_model(&provider_info(other), None).unwrap();
    assert!(
        !matches!(
            model.route.transport,
            ycoding_ai::route::Transport::Process(_)
        ),
        "a package outside the grant keeps its built-in route"
    );
    extension.shutdown().await;
    assert!(ycoding_core::extension::provider::find(PROVIDER).is_none());
    let revoked =
        ycoding_core::resources::model::from_catalog_model(&provider_info(PROVIDER), None).unwrap();
    assert!(
        !matches!(
            revoked.route.transport,
            ycoding_ai::route::Transport::Process(_)
        ),
        "shutdown revokes the process route"
    );
    fixture.cleanup();
}

#[tokio::test]
async fn malformed_provider_replies_close_the_generation_and_undecodable_frames_do_not() {
    for (outcome, closes) in [("malformed", true), ("notarray", true), ("garbage", false)] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let log = fixture.root.join("provider.log");
        let extension = support::start(
            &fixture.root,
            outcome,
            support::configuration(
                &fixture.root,
                outcome,
                json!({"provider": {"log": log, "outcomes": [outcome]}}),
                vec![family(
                    v5::CapabilityFamily::Providers,
                    &[MALFORMED_PROVIDER],
                )],
            ),
            &registry,
            fixture.policy.clone(),
            Host::default(),
            options(),
        )
        .await;
        assert!(
            provider_attempt(MALFORMED_PROVIDER).await.is_err(),
            "{outcome}"
        );
        assert_eq!(support::lines(&log), 1, "{outcome}");
        if closes {
            tokio::time::timeout(WATCHDOG, extension.closed())
                .await
                .unwrap();
            assert!(
                extension
                    .diagnostics()
                    .contains(&v5::DiagnosticCode::ProtocolRejected),
                "{outcome}"
            );
            assert!(ycoding_core::extension::provider::find(MALFORMED_PROVIDER).is_none());
        } else {
            assert!(ycoding_core::extension::provider::find(MALFORMED_PROVIDER).is_some());
        }
        extension.shutdown().await;
        fixture.cleanup();
    }
}

struct Auth {
    store: ycoding_store::Store,
    service: ycoding_core::resources::credential::Service,
    registry: ycoding_core::resources::auth::integration::Registry,
}

impl Auth {
    fn new() -> Self {
        let store = ycoding_store::Store::disposable(
            ycoding_store::Options::core(),
            ycoding_store::Catalog::new(1, ycoding_store::resources::TABLES),
            ycoding_store::Metadata::new([8; 16], 1),
        )
        .unwrap();
        let service = ycoding_core::resources::credential::Service::new(store.client());
        let registry = ycoding_core::resources::auth::integration::Registry::new(
            service.clone(),
            Default::default(),
        );
        Self {
            store,
            service,
            registry,
        }
    }
    fn host(&self) -> Host {
        Host {
            integrations: Some(self.registry.clone()),
            ..Host::default()
        }
    }
    async fn shutdown(self) {
        self.registry.shutdown().await.unwrap();
        self.service.shutdown().await.unwrap();
        self.store.shutdown().unwrap();
    }
    async fn expired(&self) -> ycoding_schema::connection::Info {
        use ycoding_schema::{
            credential, integration_id::IntegrationMethodId, schema::NonNegativeInt,
        };
        self.service
            .create(
                "stale".into(),
                "acme".into(),
                Some("Acme".into()),
                ycoding_store::resources::Secret::new(
                    credential::Value::OAuth(credential::OAuth {
                        method_id: IntegrationMethodId::new("acme-login").unwrap(),
                        access: "stale-access".into(),
                        refresh: "refresh-token".into(),
                        expires: NonNegativeInt::new(10).unwrap(),
                        metadata: None,
                    })
                    .encode(),
                )
                .unwrap(),
                1,
            )
            .await
            .unwrap();
        self.registry
            .get(&"acme".into())
            .unwrap()
            .unwrap()
            .connections
            .remove(0)
    }
}

fn oauth(refresh: bool) -> Value {
    json!([{"integration": "acme", "method": {"type": "oauth", "id": "acme-login", "label": "Acme"}, "refresh": refresh}])
}

fn access(snapshot: &ycoding_core::resources::auth::integration::Snapshot) -> String {
    match snapshot.value.as_ref().unwrap().domain().unwrap() {
        ycoding_schema::credential::Value::OAuth(value) => value.access.to_utf8().unwrap(),
        _ => panic!("oauth credential"),
    }
}

// TEST-043/044 auth row: an in-flight refresh owned by a replaced generation cannot rotate the
// account; the replacement's own refresh does.
#[tokio::test]
async fn stale_refresh_from_a_replaced_generation_cannot_update_the_account() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    let registry = fixture.registry();
    let grants = vec![family(v5::CapabilityFamily::Auth, &["acme"])];
    let first = support::start(
        &fixture.root,
        "gen_a",
        support::configuration(
            &fixture.root,
            "gen_a",
            json!({"tools": [], "oauth": oauth(true), "auth": {"refresh": "hold", "access": "gen-a-access"}}),
            grants.clone(),
        ),
        &registry,
        fixture.policy.clone(),
        auth.host(),
        options(),
    )
    .await;
    let connection = auth.expired().await;
    let held = {
        let registry = auth.registry.clone();
        let connection = connection.clone();
        tokio::spawn(async move { registry.snapshot(connection, 1_000_000).await })
    };
    support::marker(&fixture.root, "refresh-held").await;
    first.shutdown().await;
    let stale = tokio::time::timeout(WATCHDOG, held).await.unwrap().unwrap();
    std::fs::write(fixture.root.join("release-refresh"), "1").unwrap();
    match stale {
        Err(_) => {}
        Ok(snapshot) => assert_eq!(access(&snapshot), "stale-access"),
    }
    let second = support::start(
        &fixture.root,
        "gen_b",
        support::configuration(
            &fixture.root,
            "gen_b",
            json!({"tools": [], "oauth": oauth(true), "auth": {"access": "gen-b-access"}}),
            grants,
        ),
        &registry,
        fixture.policy.clone(),
        auth.host(),
        options(),
    )
    .await;
    let refreshed = auth.registry.snapshot(connection, 1_000_000).await.unwrap();
    assert_eq!(access(&refreshed), "gen-b-access");
    assert_eq!(auth.service.list(&"acme".into()).unwrap().len(), 1);
    second.shutdown().await;
    fixture.cleanup();
    auth.shutdown().await;
}

// TEST-044 shutdown during OAuth poll: the attempt settles failed once, nothing is stored, the
// methods are revoked, and no connection update is published.
#[tokio::test]
async fn shutdown_during_a_pending_oauth_poll_fails_the_attempt_and_stores_nothing() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    let registry = fixture.registry();
    let extension = support::start(
        &fixture.root,
        "poll",
        support::configuration(
            &fixture.root,
            "poll",
            json!({"tools": [], "oauth": oauth(false), "auth": {"callback": "hold"}}),
            vec![family(v5::CapabilityFamily::Auth, &["acme"])],
        ),
        &registry,
        fixture.policy.clone(),
        auth.host(),
        options(),
    )
    .await;
    let mut events = auth.registry.subscribe();
    let attempt = auth
        .registry
        .connect(
            "acme".into(),
            "acme-login".into(),
            ycoding_schema::integration::Inputs(ycoding_schema::JsonObject::new()),
            None,
            0,
        )
        .await
        .unwrap();
    assert_eq!(attempt.mode, "auto".into());
    support::marker(&fixture.root, "poll-held").await;
    extension.shutdown().await;
    let id = attempt.attempt_id.clone();
    let registry_ref = auth.registry.clone();
    support::eventually("failed attempt", move || {
        matches!(
            registry_ref.status(&"acme".into(), &id),
            Ok(ycoding_schema::integration::AttemptStatus::Failed { .. })
        )
    })
    .await;
    assert!(auth.service.list(&"acme".into()).unwrap().is_empty());
    assert!(auth.registry.get(&"acme".into()).unwrap().is_none());
    while let Ok(event) = events.try_recv() {
        assert_ne!(
            event,
            ycoding_core::resources::auth::integration::Event::ConnectionUpdated("acme".into())
        );
    }
    fixture.cleanup();
    auth.shutdown().await;
}

// TEST-043/044 public surfaces: a completed code flow stores the credential privately and its
// secrets appear in no public integration or attempt rendering.
#[tokio::test]
async fn completed_oauth_exchange_keeps_secrets_out_of_public_integration_surfaces() {
    let fixture = ToolFixture::new();
    let auth = Auth::new();
    let registry = fixture.registry();
    let extension = support::start(
        &fixture.root,
        "code",
        support::delegate(
            &fixture.root,
            "auth_code",
            "auth_code",
            &[],
            vec![family(v5::CapabilityFamily::Auth, &["acme"])],
        ),
        &registry,
        fixture.policy.clone(),
        auth.host(),
        options(),
    )
    .await;
    let attempt = auth
        .registry
        .connect(
            "acme".into(),
            "acme-login".into(),
            ycoding_schema::integration::Inputs(ycoding_schema::JsonObject::new()),
            None,
            0,
        )
        .await
        .unwrap();
    auth.registry
        .complete(&"acme".into(), &attempt.attempt_id, Some("good-code"), 1)
        .await
        .unwrap();
    assert_eq!(auth.service.list(&"acme".into()).unwrap().len(), 1);
    let public = format!(
        "{:?} {:?} {:?} {:?}",
        auth.registry.get(&"acme".into()).unwrap(),
        attempt,
        auth.registry.status(&"acme".into(), &attempt.attempt_id),
        auth.service.list(&"acme".into()).unwrap()
    );
    for secret in ["first-access", "refresh-token", "good-code"] {
        assert!(!public.contains(secret), "{secret}: {public}");
    }
    extension.shutdown().await;
    fixture.cleanup();
    auth.shutdown().await;
}

#[path = "session_flow_support/mod.rs"]
#[allow(dead_code)]
mod flow;
use ycoding_core::extension::SessionHost;

fn session_grants() -> Vec<FamilyGrant> {
    vec![family(
        v5::CapabilityFamily::Session,
        &[
            "create",
            "get",
            "prompt",
            "generate",
            "command",
            "synthetic",
            "interrupt",
        ],
    )]
}

const NATIVE: &str = "@ycoding-ai/ai/providers/openai-compatible";

struct Run {
    requests: Vec<String>,
    events: Vec<String>,
    users: Vec<String>,
    session: ycoding_schema::session::Id,
}

// Runs one real Session drain whose first model step calls the extension tool with `calls`;
// the nested host calls therefore execute while that drain owns the Session.
async fn drain(label: &str, replies: Vec<&'static str>, mcp: bool) -> Run {
    let world = support::world::world();
    let directory = support::world::directory(label);
    let name: &'static str = Box::leak(format!("ses_nested_{label}").into_boxed_str());
    let session = world.seed(name, &directory);
    let fixture = ToolFixture::new();
    fixture.authority.session(name, None, 1, false, None);
    let (endpoint, mut received, server) = flow::server(replies).await;
    let registry = flow::registry();
    let services = world.place(
        &directory,
        &fixture.root,
        support::world::catalog(&endpoint, Some(NATIVE)),
        registry.clone(),
    );
    let service = if mcp {
        Some(mcp_service(&fixture))
    } else {
        None
    };
    let host = Host {
        mcp: service.clone(),
        sessions: Some(SessionHost {
            store: world.sessions.clone(),
            location: world.location(&session),
            services: Some(Arc::new(move || Ok(services.clone()))),
        }),
        ..Host::default()
    };
    let mut grants = session_grants();
    grants.push(family(v5::CapabilityFamily::Mcp, &["docs"]));
    let extension = support::start(
        &fixture.root,
        label,
        support::configuration(&fixture.root, label, json!({"exec": "calls"}), grants),
        &registry,
        fixture.policy.clone(),
        host,
        options(),
    )
    .await;
    world
        .execution
        .prompt(
            flow::request(
                name,
                &format!("msg_start_{label}"),
                r#"{"type":"user","data":{"text":"go"},"delivery":"steer"}"#,
                &format!("evt_start_{label}"),
            ),
            Some(false),
        )
        .await
        .unwrap();
    let _settled = tokio::time::timeout(WATCHDOG, world.execution.resume(&session))
        .await
        .expect("a nested host call must not deadlock the owning drain");
    world.execution.await_idle(&session).await;
    extension.shutdown().await;
    server.abort();
    if let Some(service) = service {
        service.shutdown().await.unwrap();
    }
    let mut requests = Vec::new();
    while let Ok(body) = received.try_recv() {
        requests.push(stringify_json(&body));
    }
    let run = Run {
        requests,
        events: flow::event_types(&world.client, name),
        users: flow::user_texts(&world.sessions, name),
        session,
    };
    fixture.cleanup();
    run
}

fn tool_call(calls: &Value) -> &'static str {
    flow::tool_reply("demo_echo", &json!({"calls": calls}).to_string())
}

fn failure_detail(client: &ycoding_store::Client, session: &str) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&session.into())]);
    client
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.record.type_.as_str().unwrap().contains("failed"))
        .map(|event| format!("{:?}", event.record.data))
        .collect()
}

fn steps(run: &Run) -> (usize, usize) {
    (
        flow::count(&run.events, "session.step.started"),
        flow::count(&run.events, "session.step.ended")
            + flow::count(&run.events, "session.step.failed"),
    )
}

// TEST-043/044 Session row: nested command, synthetic, prompt, generate, create and a
// self-targeting interrupt run inside the owning drain without deadlock or a second owner.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nested_session_operations_run_inside_the_owning_drain_without_deadlock() {
    let world = support::world::world();
    let command = json!([{"op": "command", "name": "command", "session": "ses_nested_command", "message": "msg_nested_command", "delivery": "queue", "resume": true}]);
    let run = drain(
        "command",
        vec![tool_call(&command), flow::TEXT, flow::TEXT],
        false,
    )
    .await;
    assert_eq!(
        run.requests.len(),
        3,
        "the queued command runs after the first idle point"
    );
    assert!(
        run.users.iter().any(|text| text == "Run value"),
        "{:?}",
        run.users
    );
    assert_eq!(steps(&run), (3, 3));
    assert!(run.requests[2].contains("Run value"));

    let synthetic = json!([{"op": "synthetic", "name": "synthetic", "session": "ses_nested_synthetic", "message": "msg_nested_synthetic", "delivery": "queue", "text": "Observation", "resume": true}]);
    let run = drain(
        "synthetic",
        vec![tool_call(&synthetic), flow::TEXT, flow::TEXT],
        false,
    )
    .await;
    assert_eq!(run.requests.len(), 3);
    assert!(run.requests[2].contains("Observation"));
    assert_eq!(steps(&run), (3, 3));

    let prompt = json!([{"op": "prompt", "name": "prompt", "session": "ses_nested_prompt", "message": "msg_nested_prompt", "delivery": "steer", "text": "steered words", "resume": true}]);
    let run = drain("prompt", vec![tool_call(&prompt), flow::TEXT], false).await;
    assert_eq!(run.requests.len(), 2, "a steer joins the running drain");
    assert!(run.requests[1].contains("steered words"));
    assert_eq!(steps(&run), (2, 2));

    let generate = json!([{"op": "generate", "name": "generate", "session": "ses_nested_generate", "prompt": "Generate only"}]);
    let run = drain(
        "generate",
        vec![tool_call(&generate), flow::TEXT, flow::TEXT],
        false,
    )
    .await;
    assert_eq!(run.requests.len(), 3);
    assert!(run.requests[1].contains("Generate only"));
    assert!(
        !run.requests[1].contains(r#""tools":[{"#),
        "generation is tool-free"
    );
    assert_eq!(steps(&run), (2, 2), "generation is not a Session step");

    let create = json!([{"op": "create", "name": "create", "session": "ses_nested_created", "parent": "ses_nested_create"}]);
    let run = drain("create", vec![tool_call(&create), flow::TEXT], false).await;
    assert_eq!(run.requests.len(), 2);
    let created = world
        .sessions
        .get(&ycoding_schema::session::Id::new("ses_nested_created").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(created.parent_id, Some(run.session.clone()));
    assert_eq!(created.location, world.location(&run.session));
    assert!(
        flow::event_types(&world.client, "ses_nested_created")
            .iter()
            .all(|event| !event.starts_with("session.step")),
        "creation runs nothing"
    );

    let interrupt =
        json!([{"op": "interrupt", "name": "interrupt", "session": "ses_nested_interrupt"}]);
    let run = drain("interrupt", vec![tool_call(&interrupt), flow::TEXT], false).await;
    assert_eq!(
        run.requests.len(),
        1,
        "no model step follows the self-interrupt"
    );
    assert_eq!(
        steps(&run),
        (1, 1),
        "the interrupted step settles exactly once"
    );
}

fn mcp_service(fixture: &ToolFixture) -> Arc<ycoding_core::resources::mcp::Service> {
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
    let entries = [ycoding_core::resources::config::Entry::Document {
        path: None,
        info: parse_json(&json!({"mcp":{"servers":{"docs":server,"other":server}}}).to_string())
            .unwrap(),
    }];
    Arc::new(
        ycoding_core::resources::mcp::Service::new(
            &entries,
            fixture.root.clone(),
            "1".into(),
            Default::default(),
            ycoding_core::resources::mcp::client::Hooks::default(),
        )
        .unwrap(),
    )
}

// TEST-043/044 MCP row inside a drain: granted calls complete against the real peer, an
// ungranted peer is rejected before any request, and the owning step still settles once.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nested_mcp_calls_inside_a_drain_use_the_granted_peer_only() {
    let calls = json!([
        {"op": "servers", "name": "servers"},
        {"op": "call", "name": "granted", "server": "docs", "tool": "slow"},
        {"op": "call", "name": "ungranted", "server": "other", "tool": "slow"}
    ]);
    let run = drain("mcp", vec![tool_call(&calls), flow::TEXT], true).await;
    assert_eq!(run.requests.len(), 2);
    assert_eq!(steps(&run), (2, 2));
    let result = &run.requests[1];
    assert!(result.contains("granted"), "{result}");
}

fn summary(settlement: ycoding_core::tools::materialization::Settlement) -> Value {
    assert!(settlement.error.is_none(), "{:?}", settlement.error);
    serde_json::from_str(&stringify_json(&settlement.output.unwrap().structured)).unwrap()
}

async fn host_calls(
    registry: &ycoding_core::tools::registry::Registry,
    context: ycoding_core::tools::context::Context,
    calls: Value,
) -> Value {
    summary(
        registry
            .materialize(&[])
            .invoke(
                "demo_echo",
                parse_json(&json!({"calls": calls}).to_string()).unwrap(),
                context,
            )
            .await
            .unwrap(),
    )
}

// TEST-043 Session row: the four operations that need native services are fenced on the
// Location generation, denied by captured policy before any effect, and cancelled with the
// parent call; the operations that need no services stay admitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_operations_are_fenced_on_location_generation_denied_and_cancelled_with_parent() {
    use std::sync::atomic::{AtomicU8, Ordering};
    let world = support::world::world();
    let directory = support::world::directory("fence");
    let other_directory = support::world::directory("fence-other");
    let session = world.seed("ses_fence", &directory);
    let fixture = ToolFixture::new();
    fixture.authority.session("ses_fence", None, 1, false, None);
    let (release, held) = tokio::sync::oneshot::channel();
    let (endpoint, mut received, server) =
        flow::server_replies(vec![flow::Reply::Held(held, flow::TEXT)]).await;
    let catalog = || support::world::catalog(&endpoint, Some(NATIVE));
    let good = world.place(&directory, &fixture.root, catalog(), flow::registry());
    let foreign = world.place(&other_directory, &fixture.root, catalog(), flow::registry());
    let mode = Arc::new(AtomicU8::new(0));
    let resolver_mode = mode.clone();
    let host = Host {
        sessions: Some(SessionHost {
            store: world.sessions.clone(),
            location: world.location(&session),
            services: Some(Arc::new(move || {
                match resolver_mode.load(Ordering::SeqCst) {
                    0 => Ok(good.clone()),
                    1 => Err(Error::Stopped),
                    _ => Ok(foreign.clone()),
                }
            })),
        }),
        ..Host::default()
    };
    let registry = fixture.registry();
    let extension = support::start(
        &fixture.root,
        "fence",
        support::configuration(
            &fixture.root,
            "fence",
            json!({"exec": "calls"}),
            session_grants(),
        ),
        &registry,
        fixture.policy.clone(),
        host,
        options(),
    )
    .await;
    let pending = || world.sessions.pending_list(&session).unwrap().len();
    let context = |call: &str| {
        ycoding_core::tools::context::Context::new("ses_fence", "test", "msg_tool", call).unwrap()
    };
    let command = |message: &str| json!({"op": "command", "name": "command", "session": "ses_fence", "message": message, "delivery": "queue", "resume": false});
    let synthetic = |message: &str| json!({"op": "synthetic", "name": "synthetic", "session": "ses_fence", "message": message, "delivery": "queue", "resume": false});
    let generate = json!({"op": "generate", "name": "generate", "session": "ses_fence"});
    let get = json!({"op": "get", "name": "get", "session": "ses_fence"});

    let granted = host_calls(
        &registry,
        context("call_good"),
        json!([
            get,
            command("msg_good_command"),
            synthetic("msg_good_synthetic")
        ]),
    )
    .await;
    assert_eq!(granted["get"]["value"]["id"], "ses_fence");
    assert_eq!(granted["command"]["value"]["id"], "msg_good_command");
    assert_eq!(granted["synthetic"]["value"]["id"], "msg_good_synthetic");
    assert_eq!(pending(), 2);

    mode.store(1, Ordering::SeqCst);
    let stale = host_calls(
        &registry,
        context("call_stale"),
        json!([
            command("msg_stale_command"),
            generate,
            synthetic("msg_stale_synthetic")
        ]),
    )
    .await;
    assert_eq!(
        stale["command"]["failure"], 1,
        "stale Location generation rejects command"
    );
    assert_eq!(
        stale["generate"]["failure"], 1,
        "stale Location generation rejects generate"
    );
    assert_eq!(stale["synthetic"]["value"]["id"], "msg_stale_synthetic");
    assert_eq!(pending(), 3);

    mode.store(2, Ordering::SeqCst);
    let foreign = host_calls(
        &registry,
        context("call_foreign"),
        json!([command("msg_foreign_command"), generate]),
    )
    .await;
    assert_eq!(
        foreign["command"]["failure"], 1,
        "services owned by another Location are rejected"
    );
    assert_eq!(foreign["generate"]["failure"], 1);
    assert_eq!(pending(), 3);
    assert!(
        received.try_recv().is_err(),
        "no rejected call reached the model"
    );

    mode.store(0, Ordering::SeqCst);
    let cancelling = context("call_cancel");
    let token = cancelling.cancellation.clone();
    let nested = {
        let materialized = registry.materialize(&[]);
        let input = parse_json(&json!({"calls": [generate]}).to_string()).unwrap();
        tokio::spawn(async move { materialized.invoke("demo_echo", input, cancelling).await })
    };
    tokio::time::timeout(WATCHDOG, received.recv())
        .await
        .unwrap()
        .unwrap();
    token.cancel();
    assert!(matches!(
        tokio::time::timeout(WATCHDOG, nested)
            .await
            .unwrap()
            .unwrap(),
        Err(ycoding_core::tools::materialization::Error::Execution(
            ycoding_core::tools::registry::Failure::Cancelled
        ))
    ));
    drop(release);
    assert!(
        world
            .sessions
            .latest(&session, "assistant")
            .unwrap()
            .is_none()
    );
    assert_eq!(pending(), 3);

    fixture.deny("extension.family", "contract");
    let denied_prompt = json!({"op": "prompt", "name": "prompt", "session": "ses_fence", "message": "msg_denied_prompt", "resume": false});
    let denied = host_calls(
        &registry,
        context("call_denied"),
        json!([
            get,
            denied_prompt,
            {"op": "interrupt", "name": "interrupt", "session": "ses_fence"},
            {"op": "create", "name": "create", "session": "ses_denied_created"},
            command("msg_denied_command"),
            synthetic("msg_denied_synthetic"),
            generate
        ]),
    )
    .await;
    for operation in [
        "get",
        "prompt",
        "interrupt",
        "create",
        "command",
        "synthetic",
        "generate",
    ] {
        assert_eq!(denied[operation]["failure"], 1, "{operation}");
    }
    assert!(
        world
            .sessions
            .get(&ycoding_schema::session::Id::new("ses_denied_created").unwrap())
            .unwrap()
            .is_none()
    );
    assert_eq!(pending(), 3);
    extension.shutdown().await;
    server.abort();
    fixture.cleanup();
}

const BUNDLED_PROVIDER: &str = "aisdk:@ai-sdk/openai-compatible";

struct ProviderRun {
    failures: Vec<String>,
    events: Vec<String>,
    tokens: Value,
    assistant: bool,
    log: usize,
}

// Runs one real Session step whose model route is the granted process provider.
async fn provider_session(label: &str, outcome: &str, shutdown_mid_attempt: bool) -> ProviderRun {
    let world = support::world::world();
    let directory = support::world::directory(label);
    let name: &'static str = Box::leak(format!("ses_provider_{label}").into_boxed_str());
    let session = world.seed(name, &directory);
    let fixture = ToolFixture::new();
    fixture.authority.session(name, None, 1, false, None);
    let log = fixture.root.join("provider.log");
    let registry = flow::registry();
    let extension = support::start(
        &fixture.root,
        label,
        support::configuration(
            &fixture.root,
            label,
            json!({"provider": {"log": log, "outcomes": [outcome], "text": "Process answer"}}),
            vec![family(v5::CapabilityFamily::Providers, &[BUNDLED_PROVIDER])],
        ),
        &registry,
        fixture.policy.clone(),
        Host::default(),
        options(),
    )
    .await;
    world.place(
        &directory,
        &fixture.root,
        support::world::catalog("http://127.0.0.1:1", Some(BUNDLED_PROVIDER)),
        registry.clone(),
    );
    world
        .execution
        .prompt(
            flow::request(
                name,
                &format!("msg_start_{label}"),
                r#"{"type":"user","data":{"text":"go"},"delivery":"steer"}"#,
                &format!("evt_start_{label}"),
            ),
            Some(false),
        )
        .await
        .unwrap();
    if shutdown_mid_attempt {
        let execution = world.execution;
        let id = session.clone();
        let running = tokio::spawn(async move { execution.resume(&id).await });
        support::marker(&fixture.root, "provider-held").await;
        extension.shutdown().await;
        assert!(ycoding_core::extension::provider::find(BUNDLED_PROVIDER).is_none());
        let _settled = tokio::time::timeout(WATCHDOG, running)
            .await
            .unwrap()
            .unwrap();
    } else {
        let _settled = tokio::time::timeout(WATCHDOG, world.execution.resume(&session))
            .await
            .unwrap();
        extension.shutdown().await;
    }
    world.execution.await_idle(&session).await;
    let info = world.sessions.get(&session).unwrap().unwrap();
    let run = ProviderRun {
        failures: failure_detail(&world.client, name),
        events: flow::event_types(&world.client, name),
        tokens: serde_json::from_str(&stringify_json(&info.tokens.encode())).unwrap(),
        assistant: world
            .sessions
            .latest(&session, "assistant")
            .unwrap()
            .is_some(),
        log: support::lines(&log),
    };
    fixture.cleanup();
    run
}

// TEST-044: the process provider is a usable consumer route for a real Session step; a
// shutdown during the streaming attempt settles the step once and reports no phantom usage.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn process_provider_serves_a_session_step_and_shutdown_mid_attempt_settles_once() {
    let served = provider_session("served", "ok", false).await;
    assert_eq!(
        served.log,
        1,
        "one child request for the one physical attempt: {:?}",
        (&served.events, &served.failures)
    );
    assert_eq!(
        (
            flow::count(&served.events, "session.step.started"),
            flow::count(&served.events, "session.step.ended"),
            flow::count(&served.events, "session.step.failed")
        ),
        (1, 1, 0)
    );
    assert!(served.assistant);
    assert_eq!(served.tokens["input"], 10.0, "{}", served.tokens);
    assert_eq!(served.tokens["output"], 20.0, "{}", served.tokens);

    let interrupted = provider_session("held", "hang", true).await;
    assert_eq!(
        interrupted.log, 1,
        "a stopped generation is not retried by the host"
    );
    assert_eq!(flow::count(&interrupted.events, "session.step.started"), 1);
    assert_eq!(
        flow::count(&interrupted.events, "session.step.ended")
            + flow::count(&interrupted.events, "session.step.failed"),
        1,
        "{:?}",
        interrupted.events
    );
    assert_eq!(
        interrupted.tokens["input"].as_f64().unwrap_or(0.0),
        0.0,
        "no usage is invented"
    );
}

// TEST-044: obsolete JS/TS/npm configuration is rejected and never disturbs the running generation.
#[tokio::test]
async fn obsolete_javascript_configuration_is_rejected_and_the_running_generation_survives() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = ToolFixture::new();
    let registry = Arc::new(fixture.registry());
    let activation = ycoding_core::extension::Activation::new(
        fixture.root.clone(),
        options(),
        registry.clone(),
        fixture.policy.clone(),
        Launch::default(),
        Host::default(),
    );
    activation
        .activate(vec![support::configuration(
            &fixture.root,
            "kept",
            json!({}),
            vec![],
        )])
        .await
        .unwrap();
    for content in [
        r#"{"plugins":["npm:old"]}"#,
        r#"{"plugin":["old"]}"#,
        r#"{"npm":{"old":"1.0.0"}}"#,
        r#"{"provider":{"old":{}}}"#,
        r#"{"providers":{"old":{"npm":"left-pad"}}}"#,
        r#"{"providers":{"old":{"plugin":"left-pad"}}}"#,
        r#"{"providers":{"old":{"package":"left-pad"}}}"#,
    ] {
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
        assert_eq!(
            activation.reload(&configuration).await,
            Err(Error::ObsoleteConfiguration),
            "{content}"
        );
        assert_eq!(activation.list().await, ["fixture-kept"], "{content}");
    }
    for name in [
        "node",
        "bun",
        "npm",
        "npx",
        "plugin.js",
        "plugin.ts",
        "plugin.mjs",
        "plugin.cjs",
    ] {
        let launcher = fixture.root.join(name);
        std::fs::write(&launcher, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut configuration =
            support::configuration(&fixture.root, "launcher", json!({}), vec![]);
        configuration.executable = launcher;
        assert_eq!(
            configuration.validate(),
            Err(Error::ObsoleteConfiguration),
            "{name}"
        );
    }
    assert!(
        registry
            .materialize(&[])
            .invoke("demo_echo", invoke_input(), fixture.context())
            .await
            .unwrap()
            .error
            .is_none(),
        "the running generation still serves calls"
    );
    activation.close().await;
    fixture.cleanup();
}

// TEST-044: managed plugin drafts remain drafts; the adapter refuses to activate them.
#[test]
fn managed_plugin_drafts_have_no_activation_path() {
    use ycoding_core::resources::project_artifact::adapter;
    use ycoding_schema::{JsonValue, project_artifact};
    let kind =
        |name: &str| project_artifact::Kind::decode(&JsonValue::String(name.into())).unwrap();
    let unsupported = adapter::list()
        .iter()
        .filter(|entry| entry.phase == "unsupported")
        .map(|entry| entry.kind.clone())
        .collect::<Vec<_>>();
    assert_eq!(unsupported, [kind("plugin")]);
    assert_eq!(adapter::get(&kind("plugin")).phase, "unsupported");
    let definition = adapter::parse(&kind("plugin"), "export default {}").unwrap();
    assert!(matches!(
        definition,
        project_artifact::Definition::Plugin(_)
    ));
    let version = adapter::VersionIndex {
        scope_id: project_artifact::ScopeId::decode(&JsonValue::String("pas_scope".into()))
            .unwrap(),
        version_id: project_artifact::VersionId::decode(&JsonValue::String("pav_draft".into()))
            .unwrap(),
        id: project_artifact::Id::decode(&JsonValue::String("draft".into())).unwrap(),
        content_path: "/draft".into(),
        definition,
    };
    assert!(matches!(
        adapter::activate(&version, adapter::RuntimeDraft::default()),
        Err(adapter::Error::UnsupportedPlugin)
    ));
}

// TEST-044 bundled contributions: the bundled tool capability ids are exactly the plan's
// active built-in tool inventory (execute is Code Mode's own contribution, not a registration).
#[test]
fn bundled_capability_ids_cover_exactly_the_planned_builtin_tool_inventory() {
    let planned = [
        "browser",
        "computer",
        "conversation-compact",
        "decision",
        "edit",
        "glob",
        "goal",
        "grep",
        "memory",
        "patch",
        "project-artifact",
        "question",
        "read",
        "shell",
        "skill",
        "subagent",
        "subagent-control",
        "subagent-report",
        "task-complete",
        "todowrite",
        "webfetch",
        "websearch",
        "worktree",
        "write",
    ];
    let mut registered = ycoding_core::extension::capabilities::PRE
        .iter()
        .filter_map(|id| id.strip_prefix("ycoding.tool."))
        .collect::<Vec<_>>();
    registered.sort();
    assert_eq!(registered, planned);
    assert!(
        ycoding_core::extension::capabilities::PRE
            .iter()
            .chain(ycoding_core::extension::capabilities::POST)
            .all(|id| id.starts_with("ycoding.") && !id.contains("npm"))
    );
}

// END OF FLOWS
