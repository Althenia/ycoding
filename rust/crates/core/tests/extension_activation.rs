include!("tool_fixture.rs");
use std::{sync::Arc, time::Duration};
use ycoding_core::{
    event_feed::{Data, Feed, Payload, Scope, Subscriber},
    extension::{Activation, Configuration, Error, FamilyGrant, Host, Options, ToolGrant, v5},
};
use ycoding_schema::{DomainDecode, JsonValue, location, parse_json};

fn configuration(fixture: &ToolFixture, id: &str, mode: &str) -> Configuration {
    Configuration {
        identity: id.into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            mode.into(),
            fixture.root.join("journal").to_str().unwrap().into(),
        ],
        directory: fixture.root.clone(),
        grants: vec![ToolGrant {
            namespace: id.into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: vec![],
        registration_order: 0,
    }
}

fn owner(
    fixture: &ToolFixture,
) -> (
    Activation,
    Arc<ycoding_core::tools::registry::Registry>,
    Subscriber,
    location::Ref,
) {
    let registry = Arc::new(fixture.registry());
    let owner = Activation::new(
        fixture.root.clone(),
        Options {
            startup: Duration::from_secs(5),
            execution: Duration::from_millis(500),
            cleanup: Duration::from_millis(200),
            shutdown: Duration::from_millis(200),
            write: Duration::from_millis(500),
        },
        registry.clone(),
        fixture.policy.clone(),
        ycoding_core::extension::Launch::default(),
        Host::default(),
    );
    let feed = Feed::attach(&fixture.authority.store.client());
    let location = location::Ref::decode(
        &parse_json(&format!(r#"{{"directory":"{}"}}"#, fixture.root.display())).unwrap(),
    )
    .unwrap();
    owner
        .event_source
        .bind(feed.clone(), Some(location.clone()))
        .unwrap();
    let subscriber = feed.subscribe(Scope::Global, None, || {}).unwrap();
    (owner, registry, subscriber, location)
}

fn events(subscriber: &Subscriber, location: &location::Ref) -> Vec<String> {
    std::iter::from_fn(|| subscriber.next().unwrap())
        .map(|item| {
            let Payload::Ephemeral(event) = &item.payload else {
                panic!("unexpected durable event")
            };
            assert_eq!(event.location.as_ref(), Some(location));
            assert!(event.session.is_none());
            match &event.data {
                Data::PluginAdded(data) => format!("added:{}", data.id.as_str().unwrap()),
                Data::PluginUpdated(_) => "updated".into(),
                _ => event.data.name().into(),
            }
        })
        .collect()
}

fn journal(fixture: &ToolFixture) -> Vec<JsonValue> {
    std::fs::read_to_string(fixture.root.join("journal"))
        .unwrap()
        .lines()
        .map(|line| parse_json(line).unwrap())
        .collect()
}
fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    let JsonValue::Object(value) = value else {
        panic!()
    };
    value.get(&name.into()).unwrap()
}
fn pids(fixture: &ToolFixture) -> Vec<u32> {
    journal(fixture)
        .iter()
        .filter(|entry| field(entry, "event") == &JsonValue::String("start".into()))
        .map(|entry| {
            let JsonValue::Number(pid) = field(entry, "pid") else {
                panic!()
            };
            *pid as u32
        })
        .collect()
}
fn reaped(pids: &[u32]) {
    for pid in pids {
        assert!(
            !ycoding_core::platform::process::is_alive(*pid).unwrap(),
            "child {pid} still alive"
        );
    }
}

#[tokio::test]
async fn identical_ordered_configuration_is_a_noop_without_events_or_process_replacement() {
    let fixture = ToolFixture::new();
    let (owner, registry, subscriber, location) = owner(&fixture);
    owner.activate(vec![]).await.unwrap();
    assert!(events(&subscriber, &location).is_empty());
    let configs = vec![
        configuration(&fixture, "first", "lifecycle"),
        configuration(&fixture, "second", "lifecycle"),
    ];
    owner.activate(configs.clone()).await.unwrap();
    assert_eq!(
        events(&subscriber, &location),
        ["added:first", "added:second", "updated"]
    );
    let before = journal(&fixture);
    let held = owner.extensions().await;
    owner.activate(configs).await.unwrap();
    assert_eq!(
        held.iter()
            .map(|extension| extension.generation.clone())
            .collect::<Vec<_>>(),
        owner
            .extensions()
            .await
            .iter()
            .map(|extension| extension.generation.clone())
            .collect::<Vec<_>>()
    );
    assert_eq!(journal(&fixture), before);
    assert!(events(&subscriber, &location).is_empty());
    assert_eq!(owner.list().await, ["first", "second"]);
    assert!(
        registry
            .materialize(&[])
            .definitions
            .iter()
            .any(|tool| tool.name.as_str() == Some("first_echo"))
    );
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn every_configuration_field_participates_in_replacement_and_revokes_held_tools() {
    let fixture = ToolFixture::new();
    let (owner, registry, subscriber, location) = owner(&fixture);
    let mut config = configuration(&fixture, "first", "lifecycle");
    owner.activate(vec![config.clone()]).await.unwrap();
    events(&subscriber, &location);
    for change in 0..6 {
        let held = registry.materialize(&[]);
        let old = *pids(&fixture).last().unwrap();
        match change {
            0 => config.args.push("changed".into()),
            1 => config.grants[0].resources.push("other".into()),
            2 => config.families.push(FamilyGrant {
                family: v5::CapabilityFamily::Hooks,
                scopes: vec!["session.context".into()],
                action: "extension.hooks".into(),
                resources: vec!["demo".into()],
            }),
            3 => {
                config.directory = fixture.root.join("other");
                std::fs::create_dir(&config.directory).unwrap();
            }
            4 => {
                config.executable = fixture.root.join("python3");
                std::os::unix::fs::symlink("/usr/bin/python3", &config.executable).unwrap();
            }
            _ => config.registration_order += 1,
        }
        owner.activate(vec![config.clone()]).await.unwrap();
        reaped(&[old]);
        assert_ne!(*pids(&fixture).last().unwrap(), old);
        assert_eq!(events(&subscriber, &location), ["added:first", "updated"]);
        assert!(
            held.invoke("first_echo", parse_json("{}").unwrap(), fixture.context())
                .await
                .unwrap()
                .error
                .is_some()
        );
        assert!(
            registry
                .materialize(&[])
                .invoke("first_echo", parse_json("{}").unwrap(), fixture.context())
                .await
                .unwrap()
                .error
                .is_none()
        );
    }
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn failed_replacement_restores_previous_configuration_and_emits_added_for_restore() {
    let fixture = ToolFixture::new();
    let (owner, registry, subscriber, location) = owner(&fixture);
    let previous = configuration(&fixture, "first", "lifecycle");
    owner.activate(vec![previous.clone()]).await.unwrap();
    events(&subscriber, &location);
    owner
        .activate(vec![configuration(&fixture, "first", "lifecycle_fail")])
        .await
        .unwrap();
    assert_eq!(owner.list().await, ["first"]);
    assert_eq!(events(&subscriber, &location), ["added:first", "updated"]);
    assert!(
        registry
            .materialize(&[])
            .invoke("first_echo", parse_json("{}").unwrap(), fixture.context())
            .await
            .unwrap()
            .error
            .is_none()
    );
    let before = journal(&fixture);
    owner.activate(vec![previous]).await.unwrap();
    assert_eq!(journal(&fixture), before);
    assert!(events(&subscriber, &location).is_empty());
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn double_failure_deactivates_and_failed_new_definitions_do_not_block_later_entries() {
    let fixture = ToolFixture::new();
    let (owner, registry, subscriber, location) = owner(&fixture);
    owner
        .activate(vec![configuration(&fixture, "first", "lifecycle_once")])
        .await
        .unwrap();
    events(&subscriber, &location);
    owner
        .activate(vec![
            configuration(&fixture, "first", "lifecycle_fail"),
            configuration(&fixture, "bad", "lifecycle_fail"),
            configuration(&fixture, "good", "lifecycle"),
        ])
        .await
        .unwrap();
    assert_eq!(owner.list().await, ["good"]);
    assert_eq!(events(&subscriber, &location), ["added:good", "updated"]);
    assert!(
        !registry
            .materialize(&[])
            .definitions
            .iter()
            .any(|tool| tool.name.as_str() == Some("first_echo"))
    );
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn removal_and_eviction_close_in_reverse_registration_order() {
    for evict in [false, true] {
        let fixture = ToolFixture::new();
        let (owner, registry, subscriber, location) = owner(&fixture);
        owner
            .activate(
                ["first", "second", "third"]
                    .map(|id| configuration(&fixture, id, "lifecycle"))
                    .to_vec(),
            )
            .await
            .unwrap();
        events(&subscriber, &location);
        if evict {
            owner.close().await;
        } else {
            owner.activate(vec![]).await.unwrap();
        }
        assert_eq!(
            journal(&fixture)
                .iter()
                .filter(|entry| field(entry, "event") == &JsonValue::String("stop".into()))
                .map(|entry| field(entry, "id").clone())
                .collect::<Vec<_>>(),
            ["third", "second", "first"].map(|id| JsonValue::String(id.into()))
        );
        assert!(owner.list().await.is_empty());
        assert!(registry.materialize(&[]).definitions.is_empty());
        assert_eq!(
            events(&subscriber, &location),
            if evict { vec![] } else { vec!["updated"] }
        );
        if evict {
            assert_eq!(
                owner
                    .activate(vec![configuration(&fixture, "first", "lifecycle")])
                    .await,
                Err(Error::Stopped)
            );
        }
        owner.close().await;
        assert!(events(&subscriber, &location).is_empty());
        reaped(&pids(&fixture));
        fixture.cleanup();
    }
}

#[tokio::test]
async fn changed_order_reloads_every_definition_then_removes_old_entries() {
    let fixture = ToolFixture::new();
    let (owner, _, subscriber, location) = owner(&fixture);
    owner
        .activate(
            ["first", "second", "removed"]
                .map(|id| configuration(&fixture, id, "lifecycle"))
                .to_vec(),
        )
        .await
        .unwrap();
    events(&subscriber, &location);
    owner
        .activate(
            ["second", "new", "first"]
                .map(|id| configuration(&fixture, id, "lifecycle"))
                .to_vec(),
        )
        .await
        .unwrap();
    assert_eq!(owner.list().await, ["second", "new", "first"]);
    assert_eq!(
        events(&subscriber, &location),
        ["added:second", "added:new", "added:first", "updated"]
    );
    let entries = journal(&fixture);
    assert_eq!(
        field(entries.last().unwrap(), "id"),
        &JsonValue::String("removed".into())
    );
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn duplicate_ids_are_rejected_before_active_state_changes() {
    let fixture = ToolFixture::new();
    let (owner, _, subscriber, location) = owner(&fixture);
    let config = configuration(&fixture, "first", "lifecycle");
    owner.activate(vec![config.clone()]).await.unwrap();
    events(&subscriber, &location);
    let before = journal(&fixture);
    assert_eq!(
        owner.activate(vec![config.clone(), config]).await,
        Err(Error::InvalidConfiguration)
    );
    assert_eq!(
        owner
            .activate(vec![configuration(&fixture, "ycoding.agent", "lifecycle")])
            .await,
        Err(Error::InvalidConfiguration)
    );
    assert_eq!(owner.list().await, ["first"]);
    assert_eq!(journal(&fixture), before);
    assert!(events(&subscriber, &location).is_empty());
    owner.close().await;
    fixture.cleanup();
}

#[tokio::test]
async fn configuration_reload_reactivates_and_invalid_reload_preserves_active_generation() {
    let fixture = ToolFixture::new();
    let (owner, _, subscriber, location) = owner(&fixture);
    let file = fixture.root.join("ycoding.json");
    let document = |id: &str| {
        format!(
            r#"{{"extensions":[{{"identity":"{id}","executable":"/usr/bin/python3","args":["{}","lifecycle","{}"],"grants":[{{"family":"tools","namespace":"{id}","tools":["echo"],"action":"extension.echo","resources":["demo"]}}]}}]}}"#,
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py"),
            fixture.root.join("journal").display()
        )
    };
    std::fs::write(&file, document("first")).unwrap();
    let mut config = ycoding_core::resources::config::Configuration::load(
        ycoding_core::resources::config::LoadOptions {
            directory: fixture.root.clone(),
            roots: ycoding_core::resources::config::Roots::development(&fixture.root).unwrap(),
            project: false,
            file: Some(file.clone()),
            content: None,
            env: Default::default(),
        },
    )
    .unwrap();
    config.event_source = owner.event_source.clone();
    owner.reload(&config).await.unwrap();
    assert_eq!(events(&subscriber, &location), ["added:first", "updated"]);
    std::fs::write(&file, document("second")).unwrap();
    config.reload().unwrap();
    owner.reload(&config).await.unwrap();
    assert_eq!(owner.list().await, ["second"]);
    assert_eq!(
        events(&subscriber, &location),
        ["config.updated", "added:second", "updated"]
    );
    std::fs::write(&file, r#"{"extensions":42}"#).unwrap();
    config.reload().unwrap();
    assert_eq!(
        owner.reload(&config).await,
        Err(Error::InvalidConfiguration)
    );
    assert_eq!(owner.list().await, ["second"]);
    assert_eq!(events(&subscriber, &location), ["config.updated"]);
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn concurrent_identical_activations_serialize_to_one_process_generation() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::UnixListener,
    };
    let fixture = ToolFixture::new();
    let (owner, _, subscriber, location) = owner(&fixture);
    let socket = fixture.root.join("gate");
    let listener = UnixListener::bind(&socket).unwrap();
    let mut config = configuration(&fixture, "first", "lifecycle_gate");
    config.args.push(socket.to_str().unwrap().into());
    let gate = async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut started = [0; 7];
        socket.read_exact(&mut started).await.unwrap();
        assert_eq!(&started, b"started");
        socket.write_all(b"x").await.unwrap();
    };
    let (first, second, ()) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(
            owner.activate(vec![config.clone()]),
            owner.activate(vec![config]),
            gate
        )
    })
    .await
    .unwrap();
    first.unwrap();
    second.unwrap();
    assert_eq!(pids(&fixture).len(), 1);
    assert_eq!(events(&subscriber, &location), ["added:first", "updated"]);
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn concurrent_changed_activations_finish_each_pass_before_the_next_starts() {
    let fixture = ToolFixture::new();
    let (owner, _, subscriber, location) = owner(&fixture);
    let first = configuration(&fixture, "first", "lifecycle");
    let mut second = first.clone();
    second.args.push("changed".into());
    let (first, second) = tokio::join!(owner.activate(vec![first]), owner.activate(vec![second]));
    first.unwrap();
    second.unwrap();
    assert_eq!(
        events(&subscriber, &location),
        ["added:first", "updated", "added:first", "updated"]
    );
    assert_eq!(
        journal(&fixture)
            .iter()
            .map(|entry| field(entry, "event").clone())
            .collect::<Vec<_>>(),
        ["start", "stop", "start"].map(|event| JsonValue::String(event.into()))
    );
    assert_eq!(owner.list().await, ["first"]);
    owner.close().await;
    reaped(&pids(&fixture));
    fixture.cleanup();
}

#[tokio::test]
async fn plugin_list_places_native_pre_capabilities_then_extensions_then_native_post_capabilities()
{
    let fixture = ToolFixture::new();
    let (owner, _, _, _) = owner(&fixture);
    owner
        .activate(
            ["trusted-process", "another"]
                .map(|id| configuration(&fixture, id, "lifecycle"))
                .to_vec(),
        )
        .await
        .unwrap();
    let ids = owner
        .plugin_list()
        .await
        .into_iter()
        .map(|info| info.id.to_utf8().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        [
            "ycoding.agent",
            "ycoding.tool.conversation-compact",
            "ycoding.tool.computer",
            "ycoding.models-dev",
            "ycoding.provider.alibaba",
            "ycoding.provider.amazon-bedrock",
            "ycoding.provider.anthropic",
            "ycoding.provider.azure-cognitive-services",
            "ycoding.provider.azure",
            "ycoding.provider.cerebras",
            "ycoding.provider.cloudflare-ai-gateway",
            "ycoding.provider.cloudflare-workers-ai",
            "ycoding.provider.cohere",
            "ycoding.provider.cursor",
            "ycoding.provider.deepinfra",
            "ycoding.provider.gateway",
            "ycoding.provider.github-copilot",
            "ycoding.provider.gitlab",
            "ycoding.provider.google",
            "ycoding.provider.google-vertex-anthropic",
            "ycoding.provider.google-vertex",
            "ycoding.provider.groq",
            "ycoding.provider.kilo",
            "ycoding.provider.llmgateway",
            "ycoding.provider.mistral",
            "ycoding.provider.muse",
            "ycoding.provider.nvidia",
            "opencode.provider.opencode",
            "ycoding.provider.snowflake-cortex",
            "ycoding.provider.openai-compatible",
            "ycoding.provider.openai",
            "ycoding.provider.openrouter",
            "ycoding.provider.perplexity",
            "ycoding.provider.sap-ai-core",
            "ycoding.provider.togetherai",
            "ycoding.provider.vercel",
            "ycoding.provider.venice",
            "ycoding.provider.xai",
            "ycoding.provider.zenmux",
            "ycoding.tool.patch",
            "ycoding.tool.edit",
            "ycoding.tool.glob",
            "ycoding.tool.grep",
            "ycoding.tool.question",
            "ycoding.tool.read",
            "ycoding.tool.shell",
            "ycoding.tool.skill",
            "ycoding.tool.subagent",
            "ycoding.tool.subagent-control",
            "ycoding.tool.subagent-report",
            "ycoding.tool.todowrite",
            "ycoding.tool.project-artifact",
            "ycoding.tool.task-complete",
            "ycoding.tool.memory",
            "ycoding.tool.webfetch",
            "ycoding.tool.websearch",
            "ycoding.tool.write",
            "ycoding.tool.goal",
            "ycoding.tool.browser",
            "ycoding.tool.worktree",
            "trusted-process",
            "another",
            "ycoding.config.reference",
            "ycoding.config.agent",
            "ycoding.config.command",
            "ycoding.config.skill",
            "ycoding.config.provider",
            "ycoding.variant",
            "ycoding.config.policy",
            "ycoding.project-artifact.source",
        ]
    );
    owner.close().await;
    fixture.cleanup();
}
