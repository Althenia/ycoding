use super::*;
use ycoding_core::resources::config::{Configuration, LoadOptions, Roots};
use ycoding_schema::{JsonValue, ObjectEncoder, stringify_json};

const ANALYSIS: &str = "data: {\"id\":\"analysis\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"```toon\\nscene:\\n  overview: A cat\\n```\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"analysis\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

fn services(
    store: &ycoding_store::Store,
    endpoint: &str,
    provider: &str,
    package: &str,
    model: &str,
    vision: bool,
    config: &str,
) -> Services {
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(&format!(r#"{{"{provider}":{{"id":"{provider}","name":"Fixture","env":[],"npm":"{package}","api":"https://example.test/v1","models":{{"{model}":{{"id":"{model}","name":"Fixture","release_date":"2026-01-01","attachment":true,"reasoning":false,"temperature":true,"tool_call":true,"modalities":{{"input":["text"{}],"output":["text"]}},"limit":{{"context":128000,"output":8192}}}}}}}}}}"#, if vision {",\"image\""} else {""})).unwrap()).unwrap());
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"{provider}","model":"{model}"}},"providers":{{"{provider}":{{"package":"{package}","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    let root = std::env::temp_dir().join(format!("ycoding-request-config-{}", std::process::id()));
    let configuration = Arc::new(
        Configuration::load(LoadOptions {
            directory: root.clone(),
            roots: Roots::development(&root).unwrap(),
            project: false,
            file: None,
            content: Some(config.into()),
            env: Default::default(),
        })
        .unwrap(),
    );
    assert!(
        configuration.diagnostics.is_empty(),
        "{:?}",
        configuration.diagnostics
    );
    Services {
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(store.client()),
        tools: registry(),
        attachments: Arc::new(attachment_store::Store::new(root.join("attachments")).unwrap()),
        instructions: Vec::new(),
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
        claude: None,
        auth: None,
        skill_resolver: None,
        snapshots: None,
        configuration: Some(configuration),
        image_analyzer: None,
        extensions: Vec::new(),
    }
}

fn wire(value: JsonValue) -> serde_json::Value {
    serde_json::from_str(&stringify_json(&value)).unwrap()
}

fn analyzer(input: &Services) -> ycoding_core::session::image_analyzer::Service {
    ycoding_core::session::image_analyzer::Service::new(
        input.configuration.as_ref().unwrap().clone(),
        Arc::new(ycoding_core::tools::policy::helper::Models {
            models: input.models.clone(),
            credentials: input.credentials.clone(),
            auth: Default::default(),
            cursor: None,
            claude: None,
            store: input.store.clone(),
            settings: Default::default(),
        }),
        input.executor.clone(),
    )
}

#[tokio::test]
async fn privacy_and_continuation_configuration_reaches_direct_responses() {
    for (state, mode, stored, continued, compacted) in [
        ("stateless", "on", false, false, false),
        ("stateless", "on", false, false, true),
        ("stored", "off", true, false, true),
        ("stored", "on", true, true, true),
        ("stored", "auto", true, true, true),
    ] {
        let store = support::store();
        initial_context(&store);
        let service = Service::new(store.client());
        admit(&service).await;
        let (endpoint, mut requests, server) = server(vec![
            if compacted {
                with_compaction_item()
            } else {
                RESPONSES
            },
            RESPONSES,
        ])
        .await;
        let input = services(
            &store,
            &endpoint,
            "openai",
            "@ai-sdk/openai",
            "gpt-5.5",
            false,
            &format!(
                r#"{{"efficiency":{{"openai_responses_state":"{state}","openai_responses_continuation":"{mode}"}}}}"#
            ),
        );
        let coordinator = Coordinator::new(Arc::new(Local::new(input)));
        let id = session::Id::new("ses_one").unwrap();
        coordinator.run(&id).await.unwrap();
        let first = wire(requests.recv().await.unwrap());
        admit_input(&service, "second", "Again", "steer").await;
        coordinator.run(&id).await.unwrap();
        let second = wire(requests.recv().await.unwrap());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert_eq!(first["store"], stored, "{state}/{mode}");
        assert_eq!(second["store"], stored, "{state}/{mode}");
        assert_eq!(
            second["previous_response_id"].as_str().is_some(),
            continued,
            "{state}/{mode}"
        );
        assert_eq!(
            second.to_string().contains("Answer the prompt"),
            !continued && (stored || !compacted),
            "{state}/{mode}/{compacted}"
        );
        assert!(second.to_string().contains("Again"));
        if !stored {
            assert!(second.to_string().contains("encrypted_content"));
            assert_eq!(second.to_string().contains("OPAQUE-ENCRYPTED"), compacted);
        }
        assert_eq!(provider_requests(&store).len(), 2);
    }
}

#[tokio::test]
async fn cache_modes_and_retention_are_gated_on_the_selected_route_and_api_model() {
    for (provider, package, model, mode, retention, options, legacy) in [
        (
            "openai",
            "@ai-sdk/openai",
            "gpt-5.6",
            "explicit",
            true,
            Some("explicit"),
            false,
        ),
        (
            "openai",
            "@ai-sdk/openai",
            "gpt-5.6",
            "auto",
            true,
            Some("implicit"),
            false,
        ),
        (
            "openai",
            "@ai-sdk/openai",
            "gpt-5.6",
            "implicit",
            true,
            None,
            false,
        ),
        (
            "openai",
            "@ai-sdk/openai",
            "gpt-5.5",
            "explicit",
            true,
            None,
            true,
        ),
        (
            "openai",
            "@ai-sdk/openai",
            "gpt-5.5",
            "auto",
            false,
            None,
            false,
        ),
        (
            "openai",
            "@ai-sdk/openai",
            "gpt-4o",
            "explicit",
            true,
            None,
            false,
        ),
        (
            "openrouter",
            "@ycoding-ai/ai/providers/openrouter",
            "openai/gpt-5.6",
            "explicit",
            true,
            Some("explicit"),
            false,
        ),
    ] {
        let store = support::store();
        initial_context(&store);
        let service = Service::new(store.client());
        admit(&service).await;
        let (endpoint, mut requests, server) = server(vec![RESPONSES]).await;
        let coordinator = Coordinator::new(Arc::new(Local::new(services(
            &store,
            &endpoint,
            provider,
            package,
            model,
            false,
            &format!(
                r#"{{"efficiency":{{"prompt_cache":{{"openai_mode":"{mode}","openai_extended_retention":{retention}}}}}}}"#
            ),
        ))));
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        let body = wire(requests.recv().await.unwrap());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert_eq!(
            body["prompt_cache_options"]["mode"].as_str(),
            options,
            "{provider}/{model}/{mode}"
        );
        assert_eq!(
            body["prompt_cache_retention"].as_str(),
            legacy.then_some("24h"),
            "{model}"
        );
        assert!(body["prompt_cache_key"].is_string());
        assert_eq!(
            body.to_string().contains("prompt_cache_breakpoint"),
            options.is_some(),
            "{provider}/{model}/{mode}"
        );
    }
}

#[tokio::test]
async fn anthropic_ttl_obeys_policy_capability_and_root_or_child_pacing() {
    for (package, model, ttl, child, expected) in [
        ("@ai-sdk/anthropic", "claude-sonnet-4-5", "5m", false, false),
        (
            "@ycoding-ai/ai/providers/anthropic",
            "claude-sonnet-4-5",
            "1h",
            true,
            true,
        ),
        (
            "@ai-sdk/anthropic",
            "claude-sonnet-4-5",
            "adaptive",
            false,
            true,
        ),
        (
            "@ycoding-ai/ai/providers/anthropic-compatible",
            "claude-sonnet-4-5",
            "adaptive",
            true,
            false,
        ),
        ("@ai-sdk/anthropic", "claude-future", "1h", false, false),
        (
            "@ai-sdk/anthropic",
            "claude-haiku-5.5",
            "adaptive",
            false,
            true,
        ),
        (
            "@ai-sdk/anthropic",
            "claude-haiku-5.5",
            "adaptive",
            true,
            false,
        ),
        (
            "@ai-sdk/anthropic",
            "claude-sonnet-5-5",
            "adaptive",
            false,
            true,
        ),
        (
            "@ai-sdk/anthropic",
            "claude-sonnet-5-5",
            "adaptive",
            true,
            false,
        ),
    ] {
        let store = support::store();
        if child {
            store
                .submit(|tx| {
                    let mut record = tx
                        .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
                            ycoding_store::KeyPart::String(&"ses_one".into()),
                        ]))?
                        .unwrap();
                    record.parent_id = Some("ses_two".into());
                    tx.put::<ycoding_store::session::SessionTable>(&record)
                })
                .unwrap()
                .wait()
                .unwrap();
        }
        let service = Service::new(store.client());
        admit(&service).await;
        let (endpoint, mut requests, server) = server(vec![ONE_HOUR]).await;
        let coordinator = Coordinator::new(Arc::new(Local::new(services(
            &store,
            &endpoint,
            "anthropic",
            package,
            model,
            false,
            &format!(r#"{{"efficiency":{{"prompt_cache":{{"anthropic_ttl":"{ttl}"}}}}}}"#),
        ))));
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        let body = stringify_json(&requests.recv().await.unwrap());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert!(body.contains("cache_control"));
        assert_eq!(
            body.contains("\"ttl\":\"1h\""),
            expected,
            "{model}/{ttl}/{child}"
        );
    }
}

async fn attach(service: &Service, attachments: &attachment_store::Store) {
    let content = attachments.import(b"image-fixture").unwrap();
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_image").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &ObjectEncoder::new()
                    .field("type", "user")
                    .field("delivery", "steer")
                    .field(
                        "data",
                        &ObjectEncoder::new()
                            .field("text", "Read this image")
                            .field(
                                "files",
                                &vec![
                                    ObjectEncoder::new()
                                        .field("mime", "image/png")
                                        .field("name", "diagram.png")
                                        .field("description", "Original diagram")
                                        .field("content", &content)
                                        .finish(),
                                ],
                            )
                            .finish(),
                    )
                    .finish(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_image").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

#[tokio::test]
async fn image_capability_and_unavailable_analyzer_lower_to_model_visible_fallbacks() {
    for (vision, config, reason) in [
        (false, "{}", Some("image analyzer not configured")),
        (
            false,
            r#"{"image_analyzer":{"enabled":false,"model":"openai/vision"}}"#,
            Some("vision analyzer unavailable"),
        ),
        (true, "{}", None),
    ] {
        let store = support::store();
        let (endpoint, mut requests, server) = server(vec![TEXT]).await;
        let input = services(
            &store,
            &endpoint,
            "openai",
            "@ycoding-ai/ai/providers/openai-compatible",
            "text-model",
            vision,
            config,
        );
        attach(&input.store, &input.attachments).await;
        let coordinator = Coordinator::new(Arc::new(Local::new(input)));
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        let body = stringify_json(&requests.recv().await.unwrap());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert_eq!(body.contains("image_url"), vision);
        if let Some(reason) = reason {
            assert!(body.contains(reason));
            assert!(body.contains("diagram.png"));
            assert!(body.contains("Original diagram"));
            assert!(body.contains("Bytes: 13"));
        }
    }
}

#[tokio::test]
async fn configured_analyzer_runs_before_the_session_request_and_reuses_successful_analysis() {
    let store = support::store();
    let (endpoint, mut requests, server) = server(vec![ANALYSIS, TEXT, TEXT]).await;
    let mut input = services(
        &store,
        &endpoint,
        "openai",
        "@ycoding-ai/ai/providers/openai-compatible",
        "text-model",
        false,
        r#"{"image_analyzer":{"model":"openai/text-model","prompt":"VISION-PROMPT"}}"#,
    );
    input.image_analyzer = Some(analyzer(&input));
    let service = input.store.clone();
    attach(&service, &input.attachments).await;
    let coordinator = Coordinator::new(Arc::new(Local::new(input)));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let vision = wire(requests.recv().await.unwrap());
    let first = wire(requests.recv().await.unwrap());
    admit_input(&service, "again", "Explain that image again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let second = wire(requests.recv().await.unwrap());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    assert!(vision.to_string().contains("VISION-PROMPT"));
    assert!(vision.to_string().contains("image_url"));
    for request in [first, second] {
        let text = request.to_string();
        assert!(text.contains("A cat"));
        assert!(text.contains("[Image Analysis: diagram.png (image/png) via openai/text-model]"));
        assert!(text.contains("Original description: Original diagram"));
        assert!(!text.contains("image_url"));
    }
    assert_eq!(
        provider_requests(&store).len(),
        2,
        "image helpers do not become Session Steps"
    );
}

#[tokio::test]
async fn analyzer_failures_and_limits_are_visible_without_image_media_in_the_session_request() {
    for (settings, rejected) in [(r#""max_bytes":1"#, false), (r#""max_bytes":20"#, true)] {
        let store = support::store();
        let replies = if rejected {
            vec![
                (403, r#"{"error":{"message":"fixture rejection"}}"#),
                (200, TEXT),
            ]
        } else {
            vec![(200, TEXT)]
        };
        let (endpoint, mut requests, server) = server_status(replies).await;
        let mut input = services(
            &store,
            &endpoint,
            "openai",
            "@ycoding-ai/ai/providers/openai-compatible",
            "text-model",
            false,
            &format!(r#"{{"image_analyzer":{{"model":"openai/text-model",{settings}}}}}"#),
        );
        input.image_analyzer = Some(analyzer(&input));
        attach(&input.store, &input.attachments).await;
        let coordinator = Coordinator::new(Arc::new(Local::new(input)));
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        if rejected {
            assert!(stringify_json(&requests.recv().await.unwrap()).contains("image_url"));
        }
        let body = stringify_json(&requests.recv().await.unwrap());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert!(body.contains(if rejected {
            "[analysis failed]"
        } else {
            "image exceeds max_bytes 1"
        }));
        assert!(!body.contains("image_url"));
        assert!(body.contains("SHA-256:"));
    }
}

#[tokio::test]
async fn tool_result_images_are_analyzed_or_described_before_the_next_step() {
    for (vision, analyze) in [(false, false), (true, false), (false, true)] {
        let store = support::store();
        let service = Service::new(store.client());
        admit(&service).await;
        let (endpoint, mut requests, server) = server(if analyze {
            vec![TOOL, ANALYSIS, TEXT]
        } else {
            vec![TOOL, TEXT]
        })
        .await;
        let mut input = services(
            &store,
            &endpoint,
            "openai",
            "@ycoding-ai/ai/providers/openai-compatible",
            "text-model",
            vision,
            if analyze {
                r#"{"image_analyzer":{"model":"openai/text-model"}}"#
            } else {
                "{}"
            },
        );
        if analyze {
            input.image_analyzer = Some(analyzer(&input));
        }
        let corpus: serde_json::Value =
            serde_json::from_str(include_str!("../../src/resources/image/corpus.json")).unwrap();
        let uri = format!(
            "data:image/png;base64,{}",
            corpus[0]["content"]["content"].as_str().unwrap()
        );
        let _registration = input
            .tools
            .register(
                vec![(
                    "echo".into(),
                    Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                        "Image tool",
                        parse_json(r#"{"type":"object"}"#).unwrap(),
                        None,
                        None,
                        move |_, _| {
                            let uri = uri.clone();
                            Box::pin(async move {
                                Ok(ycoding_ai::llm::ToolOutput {
                                    structured: parse_json(r#"{"observation":"image captured"}"#)
                                        .unwrap(),
                                    content: vec![
                                        ycoding_schema::llm::ToolContent::Text(
                                            ycoding_schema::llm::ToolTextContent {
                                                text: "image captured".into(),
                                            },
                                        ),
                                        ycoding_schema::llm::ToolContent::File(
                                            ycoding_schema::llm::ToolFileContent {
                                                uri: uri.into(),
                                                mime: "image/png".into(),
                                                name: Some("screenshot.png".into()),
                                            },
                                        ),
                                    ],
                                })
                            })
                        },
                    )),
                )],
                ycoding_core::tools::registry::Options::direct(),
            )
            .unwrap();
        let coordinator = Coordinator::new(Arc::new(Local::new(input)));
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        requests.recv().await.unwrap();
        if analyze {
            assert!(stringify_json(&requests.recv().await.unwrap()).contains("image_url"));
        }
        let body = stringify_json(&requests.recv().await.unwrap());
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        assert!(body.contains("image captured"), "{body}");
        assert_eq!(body.contains("image_url"), vision);
        if !vision {
            assert!(body.contains(if analyze {
                "A cat"
            } else {
                "image analyzer not configured"
            }));
            assert!(body.contains("screenshot.png"));
        }
        let assistant = service
            .context(&session::Id::new("ses_one").unwrap())
            .unwrap();
        assert!(assistant.iter().any(|message| stringify_json(&message.encode()).contains("data:image/png;base64,")), "fallback does not rewrite durable output");
    }
}

async fn extension(
    fixture: &ToolFixture,
    input: &Services,
    mode: &str,
    order: u32,
) -> Arc<ycoding_core::extension::Extension> {
    let records = fixture.root.join("records.json");
    std::fs::write(&records, "[]").unwrap();
    let families = [
        (
            ycoding_core::extension::v5::CapabilityFamily::Hooks,
            vec![
                "session.context",
                "tool.execute.before",
                "tool.execute.after",
            ],
        ),
        (
            ycoding_core::extension::v5::CapabilityFamily::Transforms,
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
            ycoding_core::extension::v5::CapabilityFamily::Events,
            vec!["agent.updated"],
        ),
    ]
    .into_iter()
    .map(|(family, scopes)| ycoding_core::extension::FamilyGrant {
        family,
        scopes: scopes.into_iter().map(str::to_owned).collect(),
        action: "extension.family".into(),
        resources: vec!["demo".into()],
    })
    .collect();
    Arc::new(
        ycoding_core::extension::Extension::start(
            ycoding_core::extension::Configuration {
                identity: mode.into(),
                executable: "/usr/bin/python3".into(),
                args: vec![
                    concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
                    mode.into(),
                    records.display().to_string(),
                ],
                directory: fixture.root.clone(),
                registration_order: order,
                grants: vec![ycoding_core::extension::ToolGrant {
                    namespace: "demo".into(),
                    tools: vec!["echo".into()],
                    action: "extension.echo".into(),
                    resources: vec!["demo".into()],
                }],
                families,
            },
            ycoding_core::extension::Options {
                startup: std::time::Duration::from_secs(2),
                execution: std::time::Duration::from_secs(2),
                cleanup: std::time::Duration::from_millis(100),
                shutdown: std::time::Duration::from_millis(100),
                write: std::time::Duration::from_millis(500),
            },
            &input.tools,
            fixture.policy.clone(),
            &ycoding_core::extension::Launch::default(),
            Default::default(),
        )
        .await
        .unwrap(),
    )
}

#[tokio::test]
async fn real_process_session_context_hooks_reach_the_wire_in_registration_order() {
    let fixture = ToolFixture::new();
    fixture.authority.session("ses_one", None, 1, false, None);
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    let mut input = services(
        &store,
        &endpoint,
        "openai",
        "@ycoding-ai/ai/providers/openai-compatible",
        "text-model",
        false,
        "{}",
    );
    input.agents = Arc::new(agent::Service::new(vec![agent::empty("test".into())]));
    let mut catalog = input.models.catalog().as_ref().clone();
    catalog.configure(&[parse_json(r#"{"model":{"providerID":"openai","model":"alias"},"providers":{"openai":{"models":{"alias":{"modelID":"text-model","limit":{"context":128000,"output":8192}}}}}}"#).unwrap()]).unwrap();
    input.models.replace(catalog).unwrap();
    let mut extensions = Vec::new();
    for (mode, order) in [("familyB", 1), ("familyA", 0)] {
        extensions.push(extension(&fixture, &input, mode, order).await);
    }
    input.extensions = extensions.clone();
    let coordinator = Coordinator::new(Arc::new(Local::new(input)));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let body = stringify_json(&requests.recv().await.unwrap());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    for extension in extensions {
        extension.shutdown().await;
    }
    fixture.cleanup();
    assert!(body.contains("system-A"));
    assert!(body.contains("system-B"));
    assert!(body.find("system-A").unwrap() < body.find("system-B").unwrap());
    assert!(body.contains("Fixture toolAB"));
    assert!(body.contains("\"model\":\"text-model\""));
}

#[tokio::test]
async fn failed_context_hook_is_visible_and_does_not_block_following_hooks() {
    let fixture = ToolFixture::new();
    fixture.authority.session("ses_one", None, 1, false, None);
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    let mut input = services(
        &store,
        &endpoint,
        "openai",
        "@ycoding-ai/ai/providers/openai-compatible",
        "text-model",
        false,
        "{}",
    );
    input.agents = Arc::new(agent::Service::new(vec![agent::empty("test".into())]));
    let failed = extension(&fixture, &input, "family_fail_context", 0).await;
    let following = extension(&fixture, &input, "familyA", 1).await;
    input.extensions = vec![failed.clone(), following.clone()];
    let coordinator = Coordinator::new(Arc::new(Local::new(input)));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let body = stringify_json(&requests.recv().await.unwrap());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    failed.shutdown().await;
    following.shutdown().await;
    fixture.cleanup();
    assert!(body.contains("Session context hook failed; its changes may be incomplete."));
    assert!(body.contains("system-A"));
}

#[tokio::test]
async fn hooked_definitions_preserve_the_advertised_handlers_and_canonicalize_schema_order() {
    let fixture = ToolFixture::new();
    fixture.authority.session("ses_one", None, 1, false, None);
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![
        Box::leak(
            TOOL.replace("\\\"echo\\\"", "\\\"demo_echo\\\"")
                .replace("\"name\":\"echo\"", "\"name\":\"demo_echo\"")
                .into_boxed_str(),
        ),
        TEXT,
    ])
    .await;
    let mut input = services(
        &store,
        &endpoint,
        "openai",
        "@ycoding-ai/ai/providers/openai-compatible",
        "text-model",
        false,
        "{}",
    );
    input.agents = Arc::new(agent::Service::new(vec![agent::empty("test".into())]));
    let extension = extension(&fixture, &input, "family_context_tools", 0).await;
    input.extensions = vec![extension.clone()];
    let coordinator = Coordinator::new(Arc::new(Local::new(input)));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let first_value = requests.recv().await.unwrap();
    let first_text = stringify_json(&first_value);
    let first = wire(first_value);
    let second = stringify_json(&requests.recv().await.unwrap());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    extension.shutdown().await;
    fixture.cleanup();
    assert_eq!(first["tools"].as_array().unwrap().len(), 2);
    assert_eq!(first["tools"][0]["function"]["name"], "demo_echo");
    assert_eq!(
        first["tools"][0]["function"]["description"],
        "Fixture toolB-context"
    );
    assert_eq!(
        first["tools"][0]["function"]["parameters"]["properties"]["a"]["type"],
        "string"
    );
    assert!(
        first_text
            .contains("\"properties\":{\"a\":{\"type\":\"string\"},\"z\":{\"type\":\"string\"}}")
    );
    assert!(!first.to_string().contains("forged"));
    assert!(second.contains("child output") || second.contains("yyyy"));
}

#[tokio::test]
async fn context_hooks_cannot_resurrect_denied_step_limited_or_recovery_tools() {
    for constraint in ["permission", "step-limit", "recovery", "omit", "restore"] {
        let fixture = ToolFixture::new();
        fixture.authority.session("ses_one", None, 1, false, None);
        let store = support::store();
        let service = Service::new(store.client());
        admit(&service).await;
        let (endpoint, mut requests, server) = server(if constraint == "recovery" {
            vec![EMPTY, TEXT]
        } else {
            vec![TEXT]
        })
        .await;
        let mut input = services(
            &store,
            &endpoint,
            "openai",
            "@ycoding-ai/ai/providers/openai-compatible",
            "text-model",
            false,
            "{}",
        );
        let mut agent = agent::empty("test".into());
        if constraint == "permission" {
            agent.permissions = ycoding_schema::permission::Ruleset::decode(
                &parse_json(r#"[{"action":"extension.echo","resource":"*","effect":"deny"}]"#)
                    .unwrap(),
            )
            .unwrap();
        }
        if constraint == "step-limit" {
            agent.steps = Some(ycoding_schema::schema::PositiveInt::new(1).unwrap());
        }
        input.agents = Arc::new(agent::Service::new(vec![agent]));
        let omitted = if constraint == "restore" {
            Some(extension(&fixture, &input, "family_context_omit_tools", 0).await)
        } else {
            None
        };
        let extension = extension(
            &fixture,
            &input,
            if constraint == "omit" {
                "family_context_omit_tools"
            } else {
                "family_context_tools"
            },
            1,
        )
        .await;
        input.extensions = vec![extension.clone()];
        if let Some(omitted) = &omitted {
            input.extensions.insert(0, omitted.clone());
        }
        let coordinator = Coordinator::new(Arc::new(Local::new(input)));
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .unwrap();
        let first = requests.recv().await.unwrap();
        let last = if constraint == "recovery" {
            requests.recv().await.unwrap()
        } else {
            first
        };
        server.await.unwrap();
        coordinator.shutdown().await.unwrap();
        extension.shutdown().await;
        if let Some(omitted) = omitted {
            omitted.shutdown().await;
        }
        fixture.cleanup();
        let body = wire(last);
        if constraint == "restore" {
            assert_eq!(body["tools"].as_array().unwrap().len(), 1);
            assert_eq!(body["tools"][0]["function"]["name"], "demo_echo");
        }
        if constraint != "restore" {
            assert!(body["tools"].is_null(), "{constraint}: {body}");
        }
        assert!(body.to_string().contains("system-B"));
    }
}
