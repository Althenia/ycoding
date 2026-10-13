mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use prost::Message;
use remote_derived_support::{Fixture, world};
use std::sync::Arc;
use support::wire::{ask, refuse};
use support::{Client, text, units};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, ProviderRecord},
        command, model,
        project_artifact::{accounting, source, source_registry, store as artifact_store},
    },
    session::{compaction_policy, generate, runner, skill, store::Service},
    tools::{policy::helper, registry::Registry},
    ycoding_schema::{
        DomainDecode, LosslessString, ObjectEncoder, parse_json, session, session_skill_status,
        skill as skill_schema,
    },
};
use ycoding_protocol::v5;

fn scope(id: &str) -> v5::Scope {
    support::session_scope(id)
}
fn sid(id: &str) -> session::Id {
    session::Id::new(id).unwrap()
}

struct Skills(Vec<skill_schema::Info>);
impl skill::Resolver for Skills {
    fn list(&self) -> skill::SkillsFuture<'_> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
    fn instructions<'a>(&'a self, info: &'a skill_schema::Info) -> skill::InstructionsFuture<'a> {
        Box::pin(async move { Ok(info.content.clone()) })
    }
}

struct Artifacts {
    store: artifact_store::Service,
    source: source::Service,
}

async fn fixture(endpoint: &str) -> (Fixture, Artifacts) {
    let mut fixture = Fixture::new().await;
    let mut provider = ycoding_core::ycoding_schema::provider::Info::decode(&parse_json(&format!(r#"{{"id":"fixture","name":"Fixture","package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}"#)).unwrap()).unwrap();
    provider.integration_id = None;
    let info = |name: &str, context| {
        ycoding_core::ycoding_schema::model::Info::decode(&parse_json(&format!(r#"{{"id":"{name}","modelID":"{name}","providerID":"fixture","name":"Fixture","package":"@ycoding-ai/ai/providers/openai-compatible","capabilities":{{"tools":true,"input":["text"],"output":["text"]}},"variants":[],"time":{{"released":1}},"cost":[],"status":"active","enabled":true,"limit":{{"context":{context},"output":96}}}}"#)).unwrap()).unwrap()
    };
    let mut catalog = Catalog::default();
    let mut unsupported = info("unsupported", 4096);
    unsupported.package = Some("@fixture/unsupported".into());
    catalog.providers = vec![ProviderRecord {
        provider,
        models: vec![
            info("code", 4096),
            info("large", 32000),
            info("small", 128),
            info("tiny", 64),
            unsupported,
        ],
        environment: vec![],
    }];
    let models = Arc::new(model::Resolver::new(catalog));
    let mut reviewer = agent::empty("reviewer".into());
    reviewer.mode = "subagent".into();
    let agents = Arc::new(agent::Service::new(vec![
        agent::empty("build".into()),
        reviewer,
    ]));
    let services = world()
        .core
        .locations
        .session(&sid(&fixture.root))
        .unwrap()
        .1;
    let attachments =
        Arc::new(attachment_store::Store::new(fixture.path.join("attachments")).unwrap());
    let roots = ycoding_core::resources::config::Roots::development(&fixture.path).unwrap();
    let policy = compaction_policy::resolve(&[compaction_policy::Info {
        context_safety_margin_tokens: Some(64),
        ..Default::default()
    }]);
    let registry = Arc::new(std::sync::Mutex::new(source_registry::Registry::default()));
    let accounting = accounting::Service::new(world().store.clone(), "test-bucket-secret".into());
    let artifacts = artifact_store::Service::new(
        world().store.clone(),
        artifact_store::Paths {
            data: fixture.path.join("artifact-data"),
            home: fixture.path.join("artifact-home"),
            config: fixture.path.join("artifact-config"),
        },
        registry.clone(),
    )
    .with_accounting(accounting.clone());
    let artifact_source = source::Service::new(
        source::Options {
            client: world().store.clone(),
            store: artifacts.clone(),
            accounting,
            registry,
            location: ycoding_core::ycoding_schema::location::Ref {
                directory: services.info.directory.clone(),
                workspace_id: None,
            },
            project_id: ycoding_core::ycoding_schema::project::Id::new(fixture.project.as_str())
                .unwrap(),
            project_directory: fixture.path.clone(),
            data_root: fixture.path.join("artifact-data"),
        },
        source::Catalogs {
            agents: (*agents).clone(),
            commands: command::Service::default(),
            skills: ycoding_core::resources::skill::Service::new(&fixture.path.join("cache")),
        },
    );
    let runner = runner::Local::new(runner::Services {
        snapshots: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
        store: Service::new(world().store.clone()).with_artifact_source(artifact_source.clone()),
        events: world().core.events.clone(),
        location: ycoding_core::ycoding_schema::location::Ref {
            directory: services.info.directory.clone(),
            workspace_id: None,
        },
        models: models.clone(),
        agents: agents.clone(),
        credentials: world().core.credentials.clone(),
        tools: Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &roots,
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: attachments.clone(),
        instructions: vec![],
        analysis: None,
        clock: Arc::new(runner::WallClock),
        executor: Arc::new(ycoding_core::ycoding_ai::route::Executor::new(
            ycoding_core::ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: policy,
        guardrails: services.guardrails.clone(),
        helpers: helper::Settings::default(),
        cursor: None,
        claude: None,
        auth: None,
        skill_resolver: Some(Arc::new(Skills(
            [("audit", vec!["review"]), ("review", vec![])]
                .into_iter()
                .map(|(id, conflicts)| {
                    skill_schema::Info::decode(
                        &ObjectEncoder::new()
                            .field("id", id)
                            .field("name", id)
                            .field("content", id)
                            .field(
                                "location",
                                format!("{}/skills/{id}/SKILL.md", fixture.directory).as_str(),
                            )
                            .field(
                                "conflicts",
                                &ObjectEncoder::new()
                                    .field(
                                        "skills",
                                        &conflicts
                                            .into_iter()
                                            .map(LosslessString::from)
                                            .collect::<Vec<_>>(),
                                    )
                                    .field("instructions", &Vec::<LosslessString>::new())
                                    .finish(),
                            )
                            .finish(),
                    )
                    .unwrap()
                })
                .collect(),
        ))),
    });
    let generate_models = Arc::new(helper::Models {
        models: models.clone(),
        credentials: world().core.credentials.clone(),
        auth: Default::default(),
        cursor: None,
        claude: None,
        store: Service::new(world().store.clone()),
        settings: helper::Settings::default(),
    });
    let generation = Arc::new(generate::Service {
        store: Service::new(world().store.clone()),
        location: runner.location().clone(),
        agents: agents.clone(),
        models: generate_models,
        executor: Arc::new(ycoding_core::ycoding_ai::route::Executor::new(
            ycoding_core::ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        attachments,
        instructions: vec![],
        extensions: vec![],
    });
    let locations = world().core.locations.clone();
    fixture.catalogs.session = Some(ycoding_runtime::SessionServices {
        runner,
        generate: generation,
        destination: Some(ycoding_runtime::DestinationServices {
            resolve: Arc::new(move |target| {
                let locations = locations.clone();
                Box::pin(async move {
                    locations
                        .location(
                            target.directory.as_lossless(),
                            target.workspace_id.as_ref().map(|id| id.as_lossless()),
                        )
                        .map(|location| location.info.clone())
                        .map_err(|error| format!("{error:?}"))
                })
            }),
            invalidate: Arc::new(|_| Box::pin(async { Ok(()) })),
        }),
    });
    fixture.catalogs.models = models.clone();
    fixture.catalogs.agents = agents;
    fixture.catalogs.generate = Arc::new(ycoding_core::resources::generate::Service {
        models,
        credentials: world().core.credentials.clone(),
        integrations: fixture.registry.clone(),
        executor: Arc::new(ycoding_core::resources::generate::Executor::new(
            ycoding_core::resources::generate::Executor::http_client().unwrap(),
        )),
        cursor: None,
    });
    let mut commands = command::Service::default();
    commands.update("review".into(), |command| {
        command.template = "Review $1".into();
    });
    fixture.catalogs.commands = Arc::new(commands);
    (
        fixture,
        Artifacts {
            store: artifacts,
            source: artifact_source,
        },
    )
}

async fn open(fixture: &Fixture) -> (ycoding_runtime::Server, Client) {
    let server = support::start(
        fixture.environment(true).services.clone(),
        ycoding_runtime::standard().unwrap(),
    )
    .await;
    let client = Client::open(server.address(), &[]).await.unwrap();
    (server, client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_shell_skills_conflict_and_agent_switch_are_typed_and_durable_over_socket() {
    let (fixture, _) = fixture("http://127.0.0.1:1").await;
    let (server, mut client) = open(&fixture).await;
    let id = fixture.root.clone();
    let command = |name: &str, arguments: &str| v5::SessionCommandRequest {
        params: v5::SessionCommandRequestParams {
            session_id: text(&id),
        },
        payload: v5::SessionCommandRequestPayload {
            id: Some(text("msg_ingress_command")),
            command: text(name),
            arguments: Some(text(arguments)),
            agent: None,
            model: None,
            files: None,
            agents: None,
            delivery: Some(2),
            resume: Some(false),
        },
    };
    let admitted: v5::SessionCommandResult = ask(
        &mut client,
        "session.command",
        scope(&id),
        command("review", "first second"),
    )
    .await;
    assert_eq!(units(&admitted.data.data.text), "Review first second");
    assert_eq!(admitted.data.delivery, 2);
    let retried: v5::SessionCommandResult = ask(
        &mut client,
        "session.command",
        scope(&id),
        command("missing", "ignored"),
    )
    .await;
    assert_eq!(admitted, retried);
    let pending = world().core.sessions.pending_list(&sid(&id)).unwrap();
    assert_eq!(pending.len(), 1);
    let _: v5::SessionShellResult = ask(
        &mut client,
        "session.shell",
        scope(&id),
        v5::SessionShellRequest {
            params: v5::SessionShellRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionShellRequestPayload {
                id: Some(text("msg_ingress_shell")),
                command: text("printf ingress-shell"),
            },
        },
    )
    .await;
    let transcript = world().core.sessions.transcript(&sid(&id)).unwrap();
    let shell = transcript
        .iter()
        .find(|message| {
            matches!(
                message,
                ycoding_core::ycoding_schema::session_message::Info::Shell(_)
            )
        })
        .unwrap();
    let json = ycoding_core::ycoding_schema::DomainEncode::encode(shell);
    assert!(ycoding_core::ycoding_schema::stringify_json(&json).contains("ingress-shell"));
    let ycoding_core::ycoding_schema::session_message::Info::Shell(shell) = shell else {
        panic!("expected Shell transcript")
    };
    assert_eq!(
        fixture
            .platform
            .shell
            .get(&shell.shell_id)
            .await
            .unwrap()
            .command,
        "printf ingress-shell".into()
    );
    for name in ["audit", "review", "audit"] {
        let _: v5::SessionSkillResult = ask(
            &mut client,
            "session.skill",
            scope(&id),
            v5::SessionSkillRequest {
                params: v5::SessionSkillRequestParams {
                    session_id: text(&id),
                },
                payload: v5::SessionSkillRequestPayload {
                    id: None,
                    skill: text(name),
                    resume: Some(false),
                },
            },
        )
        .await;
    }
    let statuses: v5::SessionSkillsResult = ask(
        &mut client,
        "session.skills",
        scope(&id),
        v5::SessionSkillsRequest {
            params: v5::SessionSkillsRequestParams {
                session_id: text(&id),
            },
        },
    )
    .await;
    assert_eq!(statuses.data.items.len(), 2);
    let _: v5::SessionResolveSkillConflictResult = ask(
        &mut client,
        "session.resolveSkillConflict",
        scope(&id),
        v5::SessionResolveSkillConflictRequest {
            params: v5::SessionResolveSkillConflictRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionResolveSkillConflictRequestPayload {
                winner: text("audit"),
                loser: text("review"),
            },
        },
    )
    .await;
    assert_eq!(
        world().core.sessions.skills(&sid(&id), &[]).unwrap()[1].state,
        session_skill_status::State::Inactive {
            inactive_reason: "conflict_resolved".into()
        }
    );
    let _: v5::SkillConflictNotFoundError = refuse(
        &mut client,
        "session.resolveSkillConflict",
        scope(&id),
        v5::SessionResolveSkillConflictRequest {
            params: v5::SessionResolveSkillConflictRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionResolveSkillConflictRequestPayload {
                winner: text("audit"),
                loser: text("review"),
            },
        },
    )
    .await;
    let _: v5::SessionSwitchAgentResult = ask(
        &mut client,
        "session.switchAgent",
        scope(&id),
        v5::SessionSwitchAgentRequest {
            params: v5::SessionSwitchAgentRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionSwitchAgentRequestPayload {
                agent: text("reviewer"),
            },
        },
    )
    .await;
    assert_eq!(
        world().core.sessions.get(&sid(&id)).unwrap().unwrap().agent,
        Some("reviewer".into())
    );
    assert_eq!(
        world().core.sessions.skills(&sid(&id), &[]).unwrap()[0].state,
        session_skill_status::State::Inactive {
            inactive_reason: "agent_switched".into()
        }
    );
    world().core.execution.interrupt(&sid(&id)).await.unwrap();
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_admits_on_prior_model_when_switch_is_blocked_without_a_notice() {
    let (fixture, _) = fixture("http://127.0.0.1:1").await;
    let id = fixture.root.clone();
    let (server, mut client) = open(&fixture).await;
    let _: v5::SessionSwitchModelResult = ask(
        &mut client,
        "session.switchModel",
        scope(&id),
        v5::SessionSwitchModelRequest {
            params: v5::SessionSwitchModelRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionSwitchModelRequestPayload {
                model: v5::ModelRef {
                    provider_id: text("fixture"),
                    id: text("large"),
                    variant: None,
                    profile: None,
                },
            },
        },
    )
    .await;
    remote_derived_support::message(
        &id,
        "oversized",
        "user",
        2,
        &format!(
            r#"{{"text":"{}","time":{{"created":2,"consumed":2}}}}"#,
            "context ".repeat(1000)
        ),
    )
    .await;
    let before = world()
        .core
        .sessions
        .log(&sid(&id), None, 512)
        .unwrap()
        .events
        .len();
    let command = || v5::SessionCommandRequest {
        params: v5::SessionCommandRequestParams {
            session_id: text(&id),
        },
        payload: v5::SessionCommandRequestPayload {
            id: Some(text("msg_blocked_command")),
            command: text("review"),
            arguments: Some(text("changes")),
            model: Some(v5::ModelRef {
                provider_id: text("fixture"),
                id: text("small"),
                variant: None,
                profile: None,
            }),
            agent: None,
            agents: None,
            files: None,
            delivery: None,
            resume: Some(false),
        },
    };
    let admitted: v5::SessionCommandResult =
        ask(&mut client, "session.command", scope(&id), command()).await;
    let retried: v5::SessionCommandResult =
        ask(&mut client, "session.command", scope(&id), command()).await;
    assert_eq!(admitted, retried);
    let pending = world().core.sessions.pending_list(&sid(&id)).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(
        pending[0].data,
        parse_json(r#"{"text":"Review changes"}"#).unwrap()
    );
    assert_eq!(
        world()
            .core
            .sessions
            .get(&sid(&id))
            .unwrap()
            .unwrap()
            .model
            .unwrap()
            .id,
        "large".into()
    );
    let after = world()
        .core
        .sessions
        .log(&sid(&id), None, 512)
        .unwrap()
        .events;
    assert_eq!(
        after[before..]
            .iter()
            .map(|entry| entry.event.0.event_type.as_str().unwrap())
            .collect::<Vec<_>>(),
        vec![
            "session.compaction.admitted",
            "session.compaction.started",
            "session.compaction.ended",
            "session.input.admitted"
        ]
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn switch_and_command_failures_preserve_categories_messages_and_prior_selection() {
    let (fixture, _) = fixture("http://127.0.0.1:1").await;
    let id = fixture.root.clone();
    let (server, mut client) = open(&fixture).await;
    let _: v5::SessionSwitchModelResult = ask(
        &mut client,
        "session.switchModel",
        scope(&id),
        v5::SessionSwitchModelRequest {
            params: v5::SessionSwitchModelRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionSwitchModelRequestPayload {
                model: v5::ModelRef {
                    provider_id: text("fixture"),
                    id: text("code"),
                    variant: None,
                    profile: None,
                },
            },
        },
    )
    .await;
    let before = world()
        .core
        .sessions
        .log(&sid(&id), None, 512)
        .unwrap()
        .events;
    for (name, variant, switch_message, command_message) in [
        (
            "missing",
            None,
            "Target model is unavailable. Refresh the model catalog and select an available model.",
            "Model unavailable: fixture/missing",
        ),
        (
            "code",
            Some("missing"),
            "Target model variant is unavailable. Select a supported variant.",
            "Variant unavailable for fixture/code: missing",
        ),
        (
            "unsupported",
            None,
            "Target model uses an unsupported provider package. Check provider configuration.",
            "Unsupported package for fixture/unsupported: @fixture/unsupported",
        ),
    ] {
        let model = v5::ModelRef {
            provider_id: text("fixture"),
            id: text(name),
            variant: variant.map(text),
            profile: None,
        };
        let failed: v5::UnknownError = refuse(
            &mut client,
            "session.switchModel",
            scope(&id),
            v5::SessionSwitchModelRequest {
                params: v5::SessionSwitchModelRequestParams {
                    session_id: text(&id),
                },
                payload: v5::SessionSwitchModelRequestPayload {
                    model: model.clone(),
                },
            },
        )
        .await;
        assert_eq!(units(&failed.message), switch_message);
        assert!(units(failed.r#ref.as_ref().unwrap()).starts_with("err_"));
        let failed: v5::CommandEvaluationError = refuse(
            &mut client,
            "session.command",
            scope(&id),
            v5::SessionCommandRequest {
                params: v5::SessionCommandRequestParams {
                    session_id: text(&id),
                },
                payload: v5::SessionCommandRequestPayload {
                    id: Some(text("msg_invalid_command")),
                    command: text("review"),
                    arguments: Some(text("changes")),
                    model: Some(model),
                    agent: None,
                    agents: None,
                    files: None,
                    delivery: None,
                    resume: Some(false),
                },
            },
        )
        .await;
        assert_eq!(units(&failed.message), command_message);
        assert_eq!(
            world()
                .core
                .sessions
                .get(&sid(&id))
                .unwrap()
                .unwrap()
                .model
                .unwrap()
                .id,
            "code".into()
        );
        assert!(
            world()
                .core
                .sessions
                .pending_list(&sid(&id))
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            world()
                .core
                .sessions
                .log(&sid(&id), None, 512)
                .unwrap()
                .events,
            before
        );
    }
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_switch_move_and_subagent_launch_use_backend_owners_over_socket() {
    let (fixture, _) = fixture("http://127.0.0.1:1").await;
    let (server, mut client) = open(&fixture).await;
    let id = fixture.root.clone();
    let model = |name| v5::ModelRef {
        provider_id: text("fixture"),
        id: text(name),
        variant: None,
        profile: None,
    };
    let _: v5::SessionSwitchModelResult = ask(
        &mut client,
        "session.switchModel",
        scope(&id),
        v5::SessionSwitchModelRequest {
            params: v5::SessionSwitchModelRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionSwitchModelRequestPayload {
                model: model("code"),
            },
        },
    )
    .await;
    assert_eq!(
        world()
            .core
            .sessions
            .get(&sid(&id))
            .unwrap()
            .unwrap()
            .model
            .unwrap()
            .id,
        "code".into()
    );
    let refused: v5::UnknownError = refuse(
        &mut client,
        "session.switchModel",
        scope(&id),
        v5::SessionSwitchModelRequest {
            params: v5::SessionSwitchModelRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionSwitchModelRequestPayload {
                model: model("tiny"),
            },
        },
    )
    .await;
    assert_eq!(
        units(&refused.message),
        "Context compaction could not complete the model switch. The prior model remains selected; inspect compaction status before retrying."
    );
    assert!(units(refused.r#ref.as_ref().unwrap()).starts_with("err_"));
    let _: v5::UnknownError = refuse(
        &mut client,
        "session.switchModel",
        scope(&id),
        v5::SessionSwitchModelRequest {
            params: v5::SessionSwitchModelRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionSwitchModelRequestPayload {
                model: model("missing"),
            },
        },
    )
    .await;
    assert_eq!(
        world()
            .core
            .sessions
            .get(&sid(&id))
            .unwrap()
            .unwrap()
            .model
            .unwrap()
            .id,
        "code".into()
    );
    remote_derived_support::message(
        &id,
        "user",
        "user",
        10,
        r#"{"text":"question","time":{"created":10,"consumed":10}}"#,
    )
    .await;
    let compacted: v5::SessionCompactResult = ask(
        &mut client,
        "session.compact",
        scope(&id),
        v5::SessionCompactRequest {
            params: v5::SessionCompactRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionCompactRequestPayload {
                id: Some(text("cmp_ingress_manual")),
            },
        },
    )
    .await;
    assert_eq!(compacted.data.trigger, 4);
    assert!([1, 2].contains(&compacted.data.status));
    assert!(
        world()
            .core
            .sessions
            .compaction_job(
                &ycoding_core::session::compaction_execution::job_id(&"cmp_ingress_manual".into())
                    .unwrap()
            )
            .unwrap()
            .is_some()
    );
    let launched: v5::SessionSubagentLaunchResult = ask(
        &mut client,
        "session.subagent.launch",
        scope(&id),
        v5::SessionSubagentLaunchRequest {
            params: v5::SessionSubagentLaunchRequestParams {
                parent_id: text(&id),
            },
            payload: v5::SessionSubagentLaunch {
                parent_assistant_message_id: text("msg_ingress_parent"),
                tool_call_id: text("ingress-launch"),
                agent: text("reviewer"),
                description: text("Review"),
                prompt: text("Review the change"),
                model: None,
                background: Some(false),
            },
        },
    )
    .await;
    assert_eq!(units(&launched.data.parent_id), id);
    let child = session::Id::new(units(&launched.data.session_id)).unwrap();
    assert_eq!(
        world()
            .core
            .sessions
            .get(&child)
            .unwrap()
            .unwrap()
            .parent_id,
        Some(sid(&id))
    );
    world().core.execution.interrupt(&child).await.unwrap();
    let _: v5::SessionMoveResult = ask(
        &mut client,
        "session.move",
        scope(&id),
        v5::SessionMoveRequest {
            params: v5::SessionMoveRequestParams {
                session_id: text(&id),
            },
            payload: v5::LocationRef {
                directory: text("child"),
                workspace_id: None,
            },
        },
    )
    .await;
    assert_eq!(
        world()
            .core
            .sessions
            .get(&sid(&id))
            .unwrap()
            .unwrap()
            .location
            .directory
            .as_lossless()
            .as_str(),
        Some(fixture.child_directory.as_str())
    );
    assert!(
        !world()
            .core
            .sessions
            .transcript(&sid(&id))
            .unwrap()
            .is_empty()
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generate_returns_typed_text_without_admitting_or_mutating_transcript() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let provider = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(start) = bytes.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..start]);
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|length| length.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= start + 4 + length {
                    break;
                }
            }
        }
        let response = "data: {\"id\":\"generated\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Generated text\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"generated\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let (fixture, _) = fixture(&endpoint).await;
    let (server, mut client) = open(&fixture).await;
    let id = fixture.root.clone();
    let before = world().core.sessions.transcript(&sid(&id)).unwrap();
    let result: v5::SessionGenerateResult = ask(
        &mut client,
        "session.generate",
        scope(&id),
        v5::SessionGenerateRequest {
            params: v5::SessionGenerateRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionGenerateRequestPayload {
                prompt: text("Generate a note"),
            },
        },
    )
    .await;
    assert_eq!(units(&result.data.data.text), "Generated text");
    let request = provider.await.unwrap();
    assert!(request.contains("Generate a note"));
    assert_eq!(world().core.sessions.transcript(&sid(&id)).unwrap(), before);
    assert!(
        world()
            .core
            .sessions
            .pending_list(&sid(&id))
            .unwrap()
            .is_empty()
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_projects_optional_sandbox_warnings_and_required_sandbox_refuses_before_any_message()
{
    let (mut fixture, _) = fixture("http://127.0.0.1:1").await;
    fixture
        .configure_platform(r#"{"shell":"/bin/sh","shell_sandbox":"optional"}"#)
        .await;
    let id = fixture.root.clone();
    let shell = |command: &str| v5::SessionShellRequest {
        params: v5::SessionShellRequestParams {
            session_id: text(&id),
        },
        payload: v5::SessionShellRequestPayload {
            id: None,
            command: text(command),
        },
    };
    let shells = || {
        world()
            .core
            .sessions
            .transcript(&sid(&id))
            .unwrap()
            .into_iter()
            .filter_map(|message| match message {
                ycoding_core::ycoding_schema::session_message::Info::Shell(shell) => Some(shell),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let (server, mut client) = open(&fixture).await;
    let subscription = client
        .send(
            "event.subscribe",
            v5::Scope {
                target: Some(v5::scope::Target::Global(v5::Empty {})),
            },
            v5::EventSubscribeRequest { scope: scope(&id) }.encode_to_vec(),
        )
        .await;
    let subscription = client.subscribe_events(&subscription, scope(&id)).await;
    let _: v5::SessionShellResult = ask(
        &mut client,
        "session.shell",
        scope(&id),
        shell("echo optional"),
    )
    .await;
    let [projected] = shells()
        .try_into()
        .unwrap_or_else(|_| panic!("expected one Shell message"));
    assert_eq!(
        ycoding_core::ycoding_schema::stringify_json(
            &ycoding_core::ycoding_schema::JsonValue::Object(projected.metadata.unwrap())
        ),
        r#"{"sandboxWarnings":["No enforceable shell sandbox backend was available; command ran with host-user filesystem, process, and network authority."]}"#
    );
    let started = |client: &Client| {
        client
            .batches
            .iter()
            .filter(|batch| batch.subscription_id == subscription)
            .flat_map(|batch| &batch.events)
            .find_map(|record| {
                match v5::PublicEvent::decode(record.event.payload.as_slice())
                    .unwrap()
                    .kind
                    .unwrap()
                {
                    v5::public_event::Kind::SessionShellStarted(event) => Some(event),
                    _ => None,
                }
            })
    };
    tokio::time::timeout(support::WAIT, async {
        while started(&client).is_none() {
            client.step().await;
        }
    })
    .await
    .unwrap();
    let live = started(&client).unwrap();
    let metadata = live.metadata.unwrap();
    assert_eq!(metadata.entries.len(), 1);
    assert_eq!(units(&metadata.entries[0].key), "sandboxWarnings");
    assert_eq!(
        metadata.entries[0].value.kind,
        Some(v5::value::Kind::List(v5::ValueList {
            items: vec![v5::Value {
                kind: Some(v5::value::Kind::String(text(
                    "No enforceable shell sandbox backend was available; command ran with host-user filesystem, process, and network authority."
                )))
            }],
        }))
    );
    assert!(
        world()
            .core
            .sessions
            .log(&sid(&id), None, 512)
            .unwrap()
            .events
            .into_iter()
            .filter(|entry| entry.event.0.event_type.as_str() == Some("session.shell.started"))
            .all(|entry| entry.event.0.metadata.is_none())
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture
        .configure_platform(r#"{"shell":"/bin/sh","shell_sandbox":"required"}"#)
        .await;
    let (server, mut client) = open(&fixture).await;
    let _: v5::ServiceUnavailableError = refuse(
        &mut client,
        "session.shell",
        scope(&id),
        shell("echo required"),
    )
    .await;
    assert_eq!(shells().len(), 1);
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_command_admits_artifact_provenance_and_records_its_activation() {
    use ycoding_core::ycoding_schema::{JsonValue, project, project_artifact};
    let (mut fixture, artifacts) = fixture("http://127.0.0.1:1").await;
    let definition = project_artifact::Definition::decode(
        &ObjectEncoder::new()
            .field("kind", "command")
            .field("name", "Managed")
            .field("description", "Managed command")
            .field("subtask", &false)
            .field("mode", "subagent")
            .field("permissions", &JsonValue::Array(vec![]))
            .field("template", "Managed $1")
            .finish(),
    )
    .unwrap();
    let written = artifacts
        .store
        .write_manual(artifact_store::ManualWriteInput {
            scope: project_artifact::ScopeSelector::Project,
            project_id: Some(project::Id::new(fixture.project.as_str()).unwrap()),
            id: "managed",
            definition: &definition,
            expected: None,
            now: 100,
        })
        .unwrap();
    artifacts.source.refresh().await;
    fixture.catalogs.commands = Arc::new(artifacts.source.catalogs().await.commands);
    let (server, mut client) = open(&fixture).await;
    let id = fixture.root.clone();
    let admitted: v5::SessionCommandResult = ask(
        &mut client,
        "session.command",
        scope(&id),
        v5::SessionCommandRequest {
            params: v5::SessionCommandRequestParams {
                session_id: text(&id),
            },
            payload: v5::SessionCommandRequestPayload {
                id: Some(text("msg_managed_command")),
                command: text("managed"),
                arguments: Some(text("change")),
                agent: None,
                model: None,
                files: None,
                agents: None,
                delivery: None,
                resume: Some(false),
            },
        },
    )
    .await;
    assert_eq!(units(&admitted.data.data.text), "Managed change");
    let pending = world().core.sessions.pending_list(&sid(&id)).unwrap();
    let metadata = ycoding_core::ycoding_schema::stringify_json(&pending[0].data);
    assert!(metadata.contains(&format!(r#""projectArtifact":{{"scopeID":"{}","versionID":"{}","kind":"command","id":"managed","sourceScope":"project"}}"#, written.scope_id.as_lossless().as_str().unwrap(), written.version_id.as_lossless().as_str().unwrap())), "{metadata}");
    let rows = world()
        .store
        .snapshot()
        .unwrap()
        .scan::<ycoding_core::ycoding_store::artifacts::ActivationTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            1000,
        )
        .unwrap();
    let rows = rows
        .iter()
        .filter(|row| {
            row.message_id.as_ref().and_then(|message| message.as_str())
                == Some("msg_managed_command")
        })
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source.as_str(), Some("command"));
    assert_eq!(rows[0].version_id, *written.version_id.as_lossless());
    assert_eq!(
        rows[0]
            .session_id
            .as_ref()
            .and_then(|session| session.as_str()),
        Some(id.as_str())
    );
    assert!(
        artifacts.source.diagnostics().is_empty(),
        "{:?}",
        artifacts.source.diagnostics()
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn command_attachments_materialize_once_into_managed_files() {
    let (fixture, _) = fixture("http://127.0.0.1:1").await;
    std::fs::write(
        std::path::Path::new(&fixture.directory).join("brief.txt"),
        "brief",
    )
    .unwrap();
    let (server, mut client) = open(&fixture).await;
    let id = fixture.root.clone();
    let command = |uris: &[String]| v5::SessionCommandRequest {
        params: v5::SessionCommandRequestParams {
            session_id: text(&id),
        },
        payload: v5::SessionCommandRequestPayload {
            id: Some(text("msg_command_attachments")),
            command: text("review"),
            arguments: Some(text("files")),
            agent: None,
            model: None,
            files: Some(v5::SessionCommandRequestPayloadFiles {
                items: uris
                    .iter()
                    .map(|uri| v5::PromptInputFileAttachment {
                        uri: text(uri),
                        name: Some(text("attached")),
                        description: None,
                        mention: None,
                    })
                    .collect(),
            }),
            agents: None,
            delivery: Some(2),
            resume: Some(false),
        },
    };
    let brief =
        url::Url::from_file_path(std::path::Path::new(&fixture.directory).join("brief.txt"))
            .unwrap()
            .to_string();
    let admitted: v5::SessionCommandResult = ask(
        &mut client,
        "session.command",
        scope(&id),
        command(&[brief, "data:,inline command".into()]),
    )
    .await;
    let files = &admitted.data.data.files.as_ref().unwrap().items;
    let store = attachment_store::Store::new(fixture.path.join("data/ycoding")).unwrap();
    let content = |file: &v5::PromptFileAttachment| {
        store
            .read(
                &ycoding_core::ycoding_schema::prompt::ManagedAttachmentContent {
                    digest: ycoding_core::ycoding_schema::prompt::AttachmentDigest(
                        units(&file.content.digest).as_str().into(),
                    ),
                    bytes: ycoding_core::ycoding_schema::schema::NonNegativeInt::new(
                        file.content.bytes as i64,
                    )
                    .unwrap(),
                    path: units(&file.content.path).as_str().into(),
                },
            )
            .unwrap()
    };
    assert_eq!(
        files
            .iter()
            .map(|file| (
                content(file),
                units(&file.mime),
                file.name.as_ref().map(units)
            ))
            .collect::<Vec<_>>(),
        [
            (
                b"brief".to_vec(),
                "text/plain".into(),
                Some("attached".into())
            ),
            (
                b"inline command".to_vec(),
                "text/plain".into(),
                Some("attached".into())
            ),
        ]
    );
    fn count(path: &std::path::Path) -> usize {
        std::fs::read_dir(path).map_or(0, |entries| {
            entries
                .map(|entry| entry.unwrap().path())
                .map(|path| if path.is_dir() { count(&path) } else { 1 })
                .sum()
        })
    }
    let stored = count(&fixture.path.join("data/ycoding/attachments"));
    assert_eq!(stored, 2);
    let retried: v5::SessionCommandResult = ask(
        &mut client,
        "session.command",
        scope(&id),
        command(&["data:,not imported".into()]),
    )
    .await;
    assert_eq!(retried, admitted);
    assert_eq!(
        count(&fixture.path.join("data/ycoding/attachments")),
        stored
    );
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_move_wire_deactivates_project_artifacts_and_reselects_the_destination_default() {
    let (mut fixture, artifacts) = fixture("http://127.0.0.1:1").await;
    let definition = ycoding_core::ycoding_schema::project_artifact::Definition::decode(&parse_json(
        r#"{"kind":"agent","name":"Move agent","description":"Project review","mode":"subagent","system":"Review changes.","permissions":[]}"#,
    ).unwrap()).unwrap();
    let written = artifacts
        .store
        .write_manual(artifact_store::ManualWriteInput {
            scope: ycoding_core::ycoding_schema::project_artifact::ScopeSelector::Project,
            project_id: Some(
                ycoding_core::ycoding_schema::project::Id::new(fixture.project.as_str()).unwrap(),
            ),
            id: "move-agent",
            definition: &definition,
            expected: None,
            now: 1,
        })
        .unwrap();
    artifacts.source.refresh().await;
    let runner = &fixture.catalogs.session.as_ref().unwrap().runner;
    runner
        .switch_agent(&sid(&fixture.root), &"move-agent".into())
        .await
        .unwrap();
    let destination_path = fixture.path.join("destination");
    std::fs::create_dir_all(&destination_path).unwrap();
    let target = ycoding_core::ycoding_schema::location::Info::decode(
        &ObjectEncoder::new()
            .field("directory", destination_path.to_str().unwrap())
            .field(
                "project",
                &ObjectEncoder::new()
                    .field("id", format!("{}-moved", fixture.project).as_str())
                    .field("directory", destination_path.to_str().unwrap())
                    .finish(),
            )
            .finish(),
    )
    .unwrap();
    let mut project = world()
        .store
        .snapshot()
        .unwrap()
        .get::<ycoding_core::ycoding_store::project::ProjectTable>(
            &ycoding_core::ycoding_store::tuple_key(&[
                ycoding_core::ycoding_store::KeyPart::String(&fixture.project.as_str().into()),
            ]),
        )
        .unwrap()
        .unwrap();
    project.id = target.project.id.as_lossless().clone();
    project.worktree = target.project.directory.as_lossless().clone();
    world()
        .core
        .sessions
        .record_project(project, None)
        .await
        .unwrap();
    let info = target.clone();
    fixture
        .catalogs
        .session
        .as_mut()
        .unwrap()
        .destination
        .as_mut()
        .unwrap()
        .resolve = Arc::new(move |_| {
        let info = info.clone();
        Box::pin(async move { Ok(info) })
    });
    let mut services = fixture.environment(true).services.clone();
    let store = artifacts.store.clone();
    services.core.as_mut().unwrap().artifacts = Some(Arc::new(move |_| {
        Some(ycoding_runtime::ArtifactServices {
            store: store.clone(),
            refresh: Arc::new(|| {}),
        })
    }));
    let server = support::start(services, ycoding_runtime::standard().unwrap()).await;
    let mut client = Client::open(server.address(), &[]).await.unwrap();
    let before = remote_derived_support::now();
    let _: v5::SessionMoveResult = ask(
        &mut client,
        "session.move",
        scope(&fixture.root),
        v5::SessionMoveRequest {
            params: v5::SessionMoveRequestParams {
                session_id: text(&fixture.root),
            },
            payload: v5::LocationRef {
                directory: text(destination_path.to_str().unwrap()),
                workspace_id: None,
            },
        },
    )
    .await;
    let after = remote_derived_support::now();
    let info = world()
        .core
        .sessions
        .get(&sid(&fixture.root))
        .unwrap()
        .unwrap();
    assert_eq!(info.location.directory, target.directory);
    assert_eq!(info.project_id, target.project.id);
    assert_eq!(info.agent.unwrap().as_str(), Some("build"));
    let snapshot = world().store.snapshot().unwrap();
    let ended = snapshot
        .scan::<ycoding_core::ycoding_store::session::EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
        .into_iter()
        .find(|event| {
            event.aggregate_id.as_str() == Some(&fixture.root)
                && event.type_.as_str() == Some("session.project-artifacts-ended.1")
        })
        .unwrap();
    let activation = snapshot
        .scan::<ycoding_core::ycoding_store::artifacts::ActivationTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            usize::MAX,
        )
        .unwrap()
        .into_iter()
        .find(|row| {
            row.session_id.as_ref().and_then(LosslessString::as_str) == Some(&fixture.root)
                && row.scope_id == *written.scope_id.as_lossless()
        })
        .unwrap();
    assert_eq!(activation.deactivated_at, Some(ended.created));
    assert!((before..=after).contains(&ended.created));
    assert_eq!(activation.boundary_seq, ended.seq);
    drop(client);
    server.shutdown().await.unwrap();
    fixture.close().await;
}

#[test]
fn every_session_ingress_descriptor_has_a_handler() {
    let dispatcher = ycoding_runtime::standard().unwrap();
    for operation in [
        "session.command",
        "session.shell",
        "session.skill",
        "session.skills",
        "session.resolveSkillConflict",
        "session.compact",
        "session.generate",
        "session.move",
        "session.switchAgent",
        "session.switchModel",
        "session.subagent.launch",
    ] {
        assert!(
            dispatcher.wired().contains(&operation),
            "{operation} is unregistered"
        );
    }
}
