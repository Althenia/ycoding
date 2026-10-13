include!("tool_fixture.rs");
use std::time::Duration;
use ycoding_core::extension::{
    Configuration, Error, Extension, FamilyGrant, Host, Options, Resources, ToolGrant, context, v5,
};
use ycoding_core::resources::{agent, catalog, command, reference, skill};
use ycoding_schema::{DomainDecode, DomainEncode, JsonValue, ObjectEncoder, parse_json};

#[test]
fn configuration_admits_explicit_hook_transform_event_and_resource_scopes() {
    for (family, scope) in [
        ("hooks", "tool.execute.before"),
        ("transforms", "agents"),
        ("events", "session.created"),
        ("registrations", "agents"),
    ] {
        let fixture = ToolFixture::new();
        let content = format!(
            r#"{{"extensions":[{{"identity":"fixture","executable":"/usr/bin/python3","grants":[{{"family":"{family}","scopes":["{scope}"],"action":"extension.family","resources":["demo"]}}]}}]}}"#
        );
        let configuration = ycoding_core::resources::config::Configuration::load(
            ycoding_core::resources::config::LoadOptions {
                directory: fixture.root.clone(),
                roots: ycoding_core::resources::config::Roots::development(&fixture.root).unwrap(),
                project: false,
                file: None,
                content: Some(content),
                env: Default::default(),
            },
        )
        .unwrap();
        assert!(
            Configuration::load(&configuration, fixture.root.clone()).is_ok(),
            "{family}"
        );
        fixture.cleanup();
    }
}

fn resources(fixture: &ToolFixture) -> (Resources, Vec<JsonValue>) {
    let agent = agent::empty("custom".into());
    let command = ycoding_schema::command::Info::decode(
        &parse_json(r#"{"name":"custom","template":"Run"}"#).unwrap(),
    )
    .unwrap();
    let skill = ycoding_schema::skill::Source::decode(&parse_json(r#"{"type":"embedded","skill":{"id":"custom","name":"One","location":"/builtin/one.md","content":"body"}}"#).unwrap()).unwrap();
    let mut record = catalog::Catalog::new(
        catalog::models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    )
    .providers
    .remove(0);
    record.models.truncate(1);
    let provider = ObjectEncoder::new()
        .field("provider", &record.provider)
        .field("models", &record.models)
        .field("environment", &record.environment)
        .finish();
    let records = [
        (1., "custom", agent.encode()),
        (2., "custom", command.encode()),
        (4., "One", skill.encode()),
        (5., record.provider.id.0.as_str().unwrap(), provider),
    ]
    .into_iter()
    .map(|(domain, key, value)| {
        ObjectEncoder::new()
            .field("domain", &domain)
            .field("key", key)
            .field("value", &value)
            .finish()
    })
    .collect();
    (
        Resources {
            agents: agent::Service::new(vec![]),
            commands: command::Service::default(),
            references: reference::Service::from_infos(vec![]),
            skills: skill::Service::new(&fixture.root.join("cache")),
            catalog: catalog::Catalog::default(),
        },
        records,
    )
}
fn configuration(
    fixture: &ToolFixture,
    mode: &str,
    order: u32,
    records: &[JsonValue],
) -> Configuration {
    let file = fixture.root.join(format!("{mode}-{order}.json"));
    std::fs::write(
        &file,
        ycoding_schema::stringify_json(&JsonValue::Array(records.to_vec())),
    )
    .unwrap();
    Configuration {
        identity: format!("fixture-{order}"),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            mode.into(),
            file.to_str().unwrap().into(),
        ],
        directory: fixture.root.clone(),
        registration_order: order,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: [
            (
                v5::CapabilityFamily::Hooks,
                vec![
                    "tool.execute.before",
                    "tool.execute.after",
                    "session.context",
                ],
            ),
            (
                v5::CapabilityFamily::Transforms,
                vec![
                    "agents",
                    "commands",
                    "references",
                    "skills",
                    "catalog",
                    "tools",
                ],
            ),
            (
                v5::CapabilityFamily::Registrations,
                vec!["agents", "commands", "skills", "catalog"],
            ),
            (v5::CapabilityFamily::Events, vec!["agent.updated"]),
        ]
        .into_iter()
        .map(|(family, scopes)| FamilyGrant {
            family,
            scopes: scopes.into_iter().map(str::to_owned).collect(),
            action: "extension.family".into(),
            resources: vec!["demo".into()],
        })
        .collect(),
    }
}
fn options() -> Options {
    Options {
        startup: Duration::from_secs(1),
        execution: Duration::from_secs(2),
        cleanup: Duration::from_millis(100),
        shutdown: Duration::from_millis(100),
        write: Duration::from_millis(500),
    }
}

fn resource_events(
    resources: &Resources,
    fixture: &ToolFixture,
) -> ycoding_core::event_feed::Subscriber {
    let feed = ycoding_core::event_feed::Feed::attach(&fixture.authority.store.client());
    let location = ycoding_schema::location::Ref::decode(
        &parse_json(&format!(
            r#"{{"directory":{}}}"#,
            ycoding_schema::stringify_json(&JsonValue::String(
                fixture.root.to_str().unwrap().into()
            ))
        ))
        .unwrap(),
    )
    .unwrap();
    for source in [
        &resources.agents.event_source,
        &resources.commands.event_source,
        &resources.references.event_source,
        &resources.skills.event_source,
        &resources.catalog.event_source,
    ] {
        source.bind(feed.clone(), Some(location.clone())).unwrap();
    }
    feed.subscribe(ycoding_core::event_feed::Scope::Global, None, || {})
        .unwrap()
}
async fn start(
    fixture: &ToolFixture,
    mode: &str,
    order: u32,
    records: &[JsonValue],
    registry: &ycoding_core::tools::registry::Registry,
) -> Result<Extension, Error> {
    Extension::start(
        configuration(fixture, mode, order, records),
        options(),
        registry,
        fixture.policy.clone(),
        &ycoding_core::extension::Launch::default(),
        Host::default(),
    )
    .await
}

#[tokio::test]
async fn ordered_real_process_hooks_resources_context_and_subscription_consumers() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let (base, records) = resources(&fixture);
    let updates = resource_events(&base, &fixture);
    let second = start(&fixture, "familyB", 1, &[], &registry).await.unwrap();
    let first = start(&fixture, "familyA", 0, &records, &registry)
        .await
        .unwrap();
    let extensions = [&second, &first];
    let mut projected = base
        .materialize(&extensions, &fixture.context())
        .await
        .unwrap();
    let publications = std::iter::from_fn(|| updates.next().unwrap())
        .map(|item| {
            let ycoding_core::event_feed::Payload::Ephemeral(event) = &item.payload else {
                panic!("resource update is ephemeral");
            };
            event.data.name()
        })
        .collect::<Vec<_>>();
    assert_eq!(
        publications,
        [
            "agent.updated",
            "command.updated",
            "reference.updated",
            "skill.updated",
            "catalog.updated"
        ]
    );
    projected.agents.set_default(Some("custom".into()));
    let item = updates.next().unwrap().unwrap();
    assert!(
        matches!(&item.payload, ycoding_core::event_feed::Payload::Ephemeral(event) if event.data.name() == "agent.updated")
    );
    assert_eq!(
        projected
            .agents
            .get(&"custom".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("AB")
    );
    assert_eq!(
        projected
            .commands
            .get(&"custom".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("AB")
    );
    assert_eq!(
        projected.skills.embedded()[0].content.as_str(),
        Some("body")
    );
    assert!(
        projected.catalog.providers[0]
            .provider
            .name
            .as_str()
            .unwrap()
            .ends_with("AB")
    );
    let event = ycoding_schema::event::EphemeralPayload::<ycoding_schema::agent::Updated>::decode(
        &parse_json(r#"{"id":"evt_custom","type":"agent.updated","created":1,"data":{}}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(first.publish(&event).unwrap(), 1);
    let settlement = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await
        .unwrap();
    let output = settlement.output.unwrap();
    let JsonValue::Object(structured) = output.structured else {
        panic!("structured result")
    };
    assert_eq!(
        structured.get(&"trace".into()),
        Some(&JsonValue::String("AB".into()))
    );
    assert_eq!(
        structured.get(&"after".into()),
        Some(&JsonValue::String("AB".into()))
    );
    assert_eq!(
        structured.get(&"events".into()),
        Some(&JsonValue::Number(1.))
    );
    assert!(
        !settlement.output_paths.is_empty(),
        "after-hook output must use normal bounding"
    );
    let route = ycoding_ai::route::Route::openai_chat();
    let mut request = ycoding_ai::llm::Request::new(route.model("fixture"));
    request
        .messages
        .push(ycoding_ai::llm::Message::user("unchanged"));
    request.tools = registry
        .materialize(&[])
        .definitions
        .into_iter()
        .filter(|tool| tool.name.as_str() == Some("demo_echo"))
        .collect();
    let model = ycoding_schema::model::Ref {
        id: "fixture".into(),
        provider_id: ycoding_schema::provider::Id("openai".into()),
        variant: None,
        profile: None,
    };
    let prepared = context::prepare(
        &request,
        &model,
        Some("route"),
        &fixture.context(),
        &extensions,
    )
    .await
    .unwrap();
    assert_eq!(
        prepared
            .system
            .iter()
            .map(|part| part.text.as_str().unwrap())
            .collect::<Vec<_>>(),
        ["system-A", "system-B"]
    );
    assert!(
        prepared.tools[0]
            .description
            .as_str()
            .unwrap()
            .ends_with("AB")
    );
    assert!(route.prepare(&prepared).is_ok());
    first.shutdown().await;
    second.shutdown().await;
    assert!(
        base.materialize(&extensions, &fixture.context())
            .await
            .unwrap()
            .agents
            .list()
            .is_empty()
    );
    assert_eq!(first.publish(&event), Err(Error::Stopped));
    fixture.cleanup();
}

#[tokio::test]
async fn family_grants_revision_fences_exit_and_subscription_deadlines() {
    for mode in [
        "family_bad_subscription",
        "family_wrong_revision",
        "family_stale",
        "family_event_stall",
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let (base, records) = resources(&fixture);
        let updates = resource_events(&base, &fixture);
        let extension = start(&fixture, mode, 0, &records, &registry).await;
        if mode == "family_bad_subscription" {
            assert_eq!(extension.err(), Some(Error::Unauthorized));
            fixture.cleanup();
            continue;
        }
        let extension = extension.unwrap();
        if mode == "family_event_stall" {
            let event =
                ycoding_schema::event::EphemeralPayload::<ycoding_schema::agent::Updated>::decode(
                    &parse_json(
                        r#"{"id":"evt_custom","type":"agent.updated","created":1,"data":{}}"#,
                    )
                    .unwrap(),
                )
                .unwrap();
            extension.publish(&event).unwrap();
        } else {
            assert!(
                base.materialize(&[&extension], &fixture.context())
                    .await
                    .is_err()
            );
            assert!(updates.next().unwrap().is_none());
        }
        tokio::time::timeout(Duration::from_secs(3), extension.closed())
            .await
            .unwrap();
        assert!(
            base.materialize(&[&extension], &fixture.context())
                .await
                .unwrap()
                .agents
                .list()
                .is_empty()
        );
        extension.shutdown().await;
        fixture.cleanup();
    }
}

#[tokio::test]
async fn context_rejects_unowned_idless_duplicate_and_relabelled_messages() {
    for mode in [
        "family_context_idless",
        "family_context_role",
        "family_context_duplicate",
        "family_context_strip_origin",
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let extension = start(&fixture, mode, 0, &[], &registry).await.unwrap();
        let route = ycoding_ai::route::Route::openai_chat();
        let mut request = ycoding_ai::llm::Request::new(route.model("fixture"));
        request.messages.push(ycoding_ai::llm::Message::user(
            "owned input without durable message ID",
        ));
        let original = request.messages.clone();
        let model = ycoding_schema::model::Ref {
            id: "fixture".into(),
            provider_id: ycoding_schema::provider::Id("openai".into()),
            variant: None,
            profile: None,
        };
        assert!(
            matches!(
                context::prepare(&request, &model, None, &fixture.context(), &[&extension]).await,
                Err(Error::Unauthorized)
            ),
            "{mode}"
        );
        assert_eq!(
            request.messages, original,
            "rejected drafts must not alter the original request"
        );
        extension.shutdown().await;
        fixture.cleanup();
    }
}

#[tokio::test]
async fn subscription_quota_covers_queued_and_handed_deliveries() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "family_quota", 0, &[], &registry)
        .await
        .unwrap();
    let event = ycoding_schema::event::EphemeralPayload::<ycoding_schema::agent::Updated>::decode(
        &parse_json(r#"{"id":"evt_custom","type":"agent.updated","created":1,"data":{}}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(extension.publish(&event), Ok(8));
    assert_eq!(
        extension.publish(&event),
        Err(Error::Capacity),
        "queued delivery ownership must already consume the quota"
    );
    tokio::time::timeout(Duration::from_secs(3), extension.closed())
        .await
        .unwrap();
    assert_eq!(extension.publish(&event), Err(Error::Stopped));
    extension.shutdown().await;
    fixture.cleanup();
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    assert_eq!(
        start(&fixture, "family_nine_subscriptions", 0, &[], &registry)
            .await
            .err(),
        Some(Error::Capacity)
    );
    assert!(registry.materialize(&[]).definitions.is_empty());
    fixture.cleanup();
}

#[tokio::test]
async fn after_hook_revalidates_structured_output_without_masking_tool_failure() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "family_after_invalid", 0, &[], &registry)
        .await
        .unwrap();
    let result = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await
        .unwrap();
    assert!(
        result.error.is_some(),
        "invalid after-hook structured output must be a visible tool failure"
    );
    assert!(result.output.is_none());
    extension.shutdown().await;
    fixture.cleanup();
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "family_after_failure", 0, &[], &registry)
        .await
        .unwrap();
    let result = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await;
    let settlement = result.unwrap();
    assert!(settlement.error.is_some());
    assert!(
        matches!(
            settlement.result,
            ycoding_ai::llm::ToolResultValue::Error(_)
        ),
        "an after hook must not turn a failed tool into a successful result"
    );
    assert!(settlement.output.is_none());
    extension.shutdown().await;
    fixture.cleanup();
}

fn agent_updated() -> ycoding_schema::event::EphemeralPayload<ycoding_schema::agent::Updated> {
    ycoding_schema::event::EphemeralPayload::<ycoding_schema::agent::Updated>::decode(
        &parse_json(r#"{"id":"evt_custom","type":"agent.updated","created":1,"data":{}}"#).unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn late_subscriptions_follow_grants_release_and_known_identities() {
    for (mode, delivered) in [
        ("family_unsubscribe", Some(0)),
        ("family_late_subscribe", Some(2)),
        ("family_late_subscribe_ungranted", None),
        ("family_unknown_unsubscribe", None),
    ] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let extension = start(&fixture, mode, 0, &[], &registry).await.unwrap();
        match delivered {
            Some(count) => {
                registry
                    .materialize(&[])
                    .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
                    .await
                    .unwrap();
                assert_eq!(extension.publish(&agent_updated()), Ok(count), "{mode}");
            }
            None => {
                tokio::time::timeout(Duration::from_secs(3), extension.closed())
                    .await
                    .unwrap();
                assert!(registry.materialize(&[]).definitions.is_empty(), "{mode}");
                assert_eq!(
                    extension.publish(&agent_updated()),
                    Err(Error::Stopped),
                    "{mode}"
                );
            }
        }
        extension.shutdown().await;
        fixture.cleanup();
    }
}

#[tokio::test]
async fn exited_generation_hooks_stop_running_for_later_calls() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let stalled = start(&fixture, "family_event_stall", 0, &[], &registry)
        .await
        .unwrap();
    stalled.publish(&agent_updated()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), stalled.closed())
        .await
        .unwrap();
    let live = start(&fixture, "familyB", 1, &[], &registry).await.unwrap();
    let settlement = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await
        .expect("a closed generation's hooks must no longer run");
    assert!(settlement.error.is_none());
    let JsonValue::Object(structured) = settlement.output.unwrap().structured else {
        panic!("structured result")
    };
    assert_eq!(
        structured.get(&"trace".into()),
        Some(&JsonValue::String("B".into()))
    );
    live.shutdown().await;
    stalled.shutdown().await;
    fixture.cleanup();
}

#[test]
fn duplicate_family_scope_grants_are_rejected() {
    let fixture = ToolFixture::new();
    let grant = |resource: &str| FamilyGrant {
        family: v5::CapabilityFamily::Hooks,
        scopes: vec!["session.context".into()],
        action: "extension.family".into(),
        resources: vec![resource.into()],
    };
    let mut config = configuration(&fixture, "familyA", 0, &[]);
    config.families = vec![grant("demo")];
    assert_eq!(config.validate(), Ok(()));
    config.families = vec![grant("demo"), grant("other")];
    assert_eq!(config.validate(), Err(Error::InvalidConfiguration));
    fixture.cleanup();
}

#[tokio::test]
async fn all_tool_transforms_precede_context_hooks_in_host_order() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let later = start(&fixture, "familyB", 1, &[], &registry).await.unwrap();
    let earlier = start(&fixture, "family_context_requires_tools", 0, &[], &registry)
        .await
        .unwrap();
    let route = ycoding_ai::route::Route::openai_chat();
    let mut request = ycoding_ai::llm::Request::new(route.model("fixture"));
    request
        .messages
        .push(ycoding_ai::llm::Message::user("owned"));
    request.tools = registry
        .materialize(&[])
        .definitions
        .into_iter()
        .filter(|tool| tool.name.as_str() == Some("demo_echo"))
        .collect();
    let model = ycoding_schema::model::Ref {
        id: "fixture".into(),
        provider_id: ycoding_schema::provider::Id("openai".into()),
        variant: None,
        profile: None,
    };
    assert!(
        context::prepare(
            &request,
            &model,
            None,
            &fixture.context(),
            &[&later, &earlier]
        )
        .await
        .is_ok()
    );
    earlier.shutdown().await;
    later.shutdown().await;
    fixture.cleanup();
}

#[test]
fn invalid_family_scope_is_rejected_before_launch() {
    let fixture = ToolFixture::new();
    for (family, scope) in [
        (v5::CapabilityFamily::Hooks, "unrecognized"),
        (v5::CapabilityFamily::Events, "credential.changed"),
        (v5::CapabilityFamily::Registrations, "session.context"),
    ] {
        let mut config = configuration(&fixture, "familyA", 0, &[]);
        config.families = vec![FamilyGrant {
            family,
            scopes: vec![scope.into()],
            action: "extension.family".into(),
            resources: vec!["demo".into()],
        }];
        assert_eq!(config.validate(), Err(Error::InvalidConfiguration));
    }
    assert!(!fixture.root.join("extension-child.pid").exists());
    fixture.cleanup();
}

#[tokio::test]
async fn unsolicited_transform_results_close_and_revoke_the_generation() {
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "family_unsolicited", 0, &[], &registry)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), extension.closed())
        .await
        .unwrap();
    assert!(registry.materialize(&[]).definitions.is_empty());
    assert!(!ycoding_core::platform::process::is_alive(extension.pid()).unwrap());
    extension.shutdown().await;
    fixture.cleanup();
}

#[tokio::test]
async fn context_preserves_all_part_kinds_lossless_content_and_cache_metadata() {
    use ycoding_ai::{
        cache::Hint,
        llm::{
            Media, MediaData, Message, Part, Reasoning, Role, ToolCall, ToolOutput, ToolResult,
            ToolResultValue,
        },
    };
    let fixture = ToolFixture::new();
    let registry = fixture.registry();
    let extension = start(&fixture, "familyB", 0, &[], &registry).await.unwrap();
    let route = ycoding_ai::route::Route::openai_chat();
    let mut request = ycoding_ai::llm::Request::new(route.model("fixture"));
    let mut text = ycoding_ai::llm::TextPart::from("owned text");
    text.cache = Some(Hint::ephemeral(Some(3600.)));
    text.metadata = Some(parse_json(r#"{"owner":"host","zero":0}"#).unwrap());
    text.provider_metadata = Some(parse_json(r#"{"route":"private"}"#).unwrap());
    request.system.push(text.clone());
    let mut message = Message::new(
        Role::Assistant,
        vec![
            Part::Text(text),
            Part::Media(Media {
                mime: "image/png".into(),
                data: MediaData::Bytes(vec![1, 2, 3, 4]),
                filename: Some("owned.png".into()),
            }),
            Part::Media(Media {
                mime: "image/png".into(),
                data: MediaData::Encoded("data:image/png;base64,AQIDBA==".into()),
                filename: None,
            }),
            Part::Reasoning(Reasoning {
                text: ycoding_schema::LosslessString::from_utf16(vec![0xd800]),
                encrypted: Some("opaque".into()),
                provider_metadata: Some(JsonValue::Bool(false)),
            }),
            Part::ToolCall(ToolCall {
                id: "call_owned".into(),
                name: "echo".into(),
                input: parse_json("{}").unwrap(),
                provider_executed: Some(false),
                provider_metadata: Some(JsonValue::Null),
            }),
            Part::ToolResult(ToolResult {
                id: "call_owned".into(),
                name: "echo".into(),
                result: ToolResultValue::Json(JsonValue::Bool(false)),
                cache: Some(Hint::ephemeral(None)),
                provider_executed: Some(false),
                provider_metadata: Some(JsonValue::Null),
                output: Some(ToolOutput {
                    structured: JsonValue::Bool(false),
                    content: vec![],
                }),
            }),
        ],
    );
    message.volatile = true;
    message.metadata = Some(parse_json(r#"{"source":"trusted"}"#).unwrap());
    message.native = Some(parse_json(r#"{"native":true}"#).unwrap());
    request.messages.push(message);
    let model = ycoding_schema::model::Ref {
        id: "fixture".into(),
        provider_id: ycoding_schema::provider::Id("openai".into()),
        variant: Some("variant".into()),
        profile: Some(DomainDecode::decode(&JsonValue::String("profile".into())).unwrap()),
    };
    let result = context::prepare(
        &request,
        &model,
        Some("owned-route"),
        &fixture.context(),
        &[&extension],
    )
    .await
    .unwrap();
    assert_eq!(result.messages, request.messages);
    assert_eq!(result.system[0], request.system[0]);
    extension.shutdown().await;
    fixture.cleanup();
}

#[tokio::test]
async fn after_hooks_keep_output_and_visible_result_independent_and_bounded() {
    for mode in ["family_after_result_only", "family_after_output_only"] {
        let fixture = ToolFixture::new();
        let registry = fixture.registry();
        let extension = start(&fixture, mode, 0, &[], &registry).await.unwrap();
        let settlement = registry
            .materialize(&[])
            .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
            .await
            .unwrap();
        assert!(settlement.error.is_none());
        assert!(!settlement.output_paths.is_empty());
        let output = settlement.output.unwrap();
        if mode == "family_after_result_only" {
            assert_eq!(
                output.content,
                vec![ycoding_schema::llm::ToolContent::Text(
                    ycoding_schema::llm::ToolTextContent {
                        text: "child output".into()
                    }
                )]
            );
            assert!(settlement.result.to_text().code_units().count() < 80000);
        } else {
            assert_eq!(
                settlement.result,
                ycoding_ai::llm::ToolResultValue::Text(JsonValue::String("child output".into()))
            );
            assert!(output.result().to_text().code_units().count() < 80000);
        }
        extension.shutdown().await;
        fixture.cleanup();
    }
}
