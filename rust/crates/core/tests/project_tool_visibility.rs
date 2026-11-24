use std::{sync::Arc, time::Duration};
use ycoding_core::{
    coordination::{OwnerInput, Service},
    event_feed::Feed,
    resources::{
        agent, catalog::Catalog, config, domain_state::DomainState, mcp, reference, skill,
        tool_output_store,
    },
    session::{
        generate,
        instruction_assembly::{self, Context},
    },
    tools::{
        builtin::project::{self, Project},
        context::Context as ToolContext,
        registry::{DynamicTool, Options, Registry, Tool},
    },
};
use ycoding_schema::{
    DomainDecode, coordination as c, model, parse_json,
    permission::{Effect, Rule},
    session,
};
use ycoding_store::{
    Metadata, Options as StoreOptions, Store,
    native::{self, DatabaseKind},
    project as project_tables, session as tables,
};

fn row(id: &str, parent: Option<&str>) -> tables::Session {
    tables::Session {
        id: id.into(),
        project_id: "prj_visibility".into(),
        workspace_id: None,
        parent_id: parent.map(Into::into),
        fork_session_id: None,
        fork_message_id: None,
        fork_seq: None,
        directory: "/synthetic".into(),
        path: None,
        title: id.into(),
        cost: 0.0,
        tokens_input: 0,
        tokens_output: 0,
        tokens_reasoning: 0,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        revert: None,
        permission: None,
        autonomy: None,
        autonomy_revision: 0,
        orchestration_revision: 0,
        agent: None,
        model: None,
        profile_binding: None,
        daybreak: None,
        time_created: 1,
        time_updated: 1,
        time_archived: None,
        time_active: None,
        time_pinned: None,
        time_suspended: None,
        usage_pruned_through: None,
        origin: None,
        scope: "bound".into(),
    }
}

struct World {
    _store: Store,
    coordination: Service,
    registry: Arc<Registry>,
    context: Context,
    runtime: Arc<std::sync::OnceLock<ycoding_core::coordination::runtime::Runtime>>,
    _scope: ycoding_core::tools::registry::Registration,
    _mcp: Arc<mcp::Service>,
}

fn id(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

fn rule(action: &str, effect: &str) -> Rule {
    Rule {
        action: action.into(),
        resource: "*".into(),
        effect: Effect(effect.into()),
    }
}

fn dummy(name: &str) -> (String, Arc<dyn Tool>) {
    (
        name.into(),
        Arc::new(DynamicTool::new(
            "test",
            ycoding_schema::JsonValue::Null,
            None,
            None,
            |_, _| {
                Box::pin(async {
                    Ok(ycoding_ai::llm::ToolOutput {
                        structured: ycoding_schema::JsonValue::Null,
                        content: vec![],
                    })
                })
            },
        )),
    )
}

async fn world() -> World {
    let directory = std::env::temp_dir().canonicalize().unwrap();
    let store = Store::disposable(
        StoreOptions::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([47; 16], 1),
    )
    .unwrap();
    store
        .submit(move |tx| {
            project_tables::ProjectTable::insert(
                tx,
                &project_tables::Project {
                    id: "prj_visibility".into(),
                    worktree: directory.to_str().unwrap().into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            for (session, parent) in [
                ("ses_master", None),
                ("ses_member", None),
                ("ses_other", None),
                ("ses_scout", Some("ses_master")),
                ("ses_supervisor", Some("ses_master")),
                ("ses_grandchild", Some("ses_member")),
            ] {
                tables::SessionTable::insert(tx, &row(session, parent))?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let feed = Feed::attach(&store.client());
    let coordination = Service::new(store.client(), feed);
    let group = coordination
        .create(c::CreateInput {
            name: "Visibility".into(),
            master_session_id: id("ses_master"),
            member_session_ids: vec![id("ses_member")],
        })
        .await
        .unwrap();
    coordination
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: id("ses_member"),
                owner_session_id: Some(id("ses_supervisor")),
                reason: None,
            },
        )
        .await
        .unwrap();
    let roots = config::Roots::development(&std::env::temp_dir().join(format!(
        "project-visibility-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )))
    .unwrap();
    let configuration = Arc::new(
        config::Configuration::load(config::LoadOptions {
            directory: roots.home.clone(),
            roots: roots.clone(),
            project: false,
            file: None,
            content: Some("{}".into()),
            env: Default::default(),
        })
        .unwrap(),
    );
    let registry = Arc::new(Registry::new(
        Arc::new(tool_output_store::Store::new(&roots)),
        Some(configuration.clone()),
        Default::default(),
        Arc::new(|a, b| a.cmp(b)),
    ));
    let runtime = Arc::default();
    let mut tools = vec![dummy("read"), dummy("subagent"), dummy("subagent_control")];
    tools.push((
        project::NAME.into(),
        Arc::new(Project {
            runtime: Arc::clone(&runtime),
        }) as Arc<dyn Tool>,
    ));
    let scope = registry
        .register(
            tools,
            Options {
                namespace: None,
                codemode: false,
            },
        )
        .unwrap();
    let mcp = Arc::new(
        mcp::Service::new(
            &[],
            "/project".into(),
            "test".into(),
            Default::default(),
            Default::default(),
        )
        .unwrap(),
    );
    let context = Context {
        configuration,
        registry: registry.clone(),
        skills: Arc::new(tokio::sync::Mutex::new(skill::Service::new(
            &std::env::temp_dir(),
        ))),
        mcp: Arc::downgrade(&mcp),
        references: DomainState::new(reference::Service::from_infos(Vec::new())),
        coordination: coordination.clone(),
    };
    World {
        _store: store,
        coordination,
        registry,
        context,
        runtime,
        _scope: scope,
        _mcp: mcp,
    }
}

#[test]
fn yolo_tool_permissions_remove_agent_and_saved_denies_without_removing_project_boundaries() {
    let mut agent = agent::empty("worker".into());
    agent.permissions = vec![rule("shell", "deny")];
    agent.mode = "subagent".into();
    let mut ceiling = instruction_assembly::project_ceiling(&[rule("read", "deny")], false);
    let manual = instruction_assembly::tool_permissions(&agent, &ceiling);
    assert!(
        manual
            .iter()
            .any(|rule| rule.action.as_str() == Some("shell"))
    );
    assert!(
        manual
            .iter()
            .any(|rule| rule.action.as_str() == Some("read"))
    );
    ceiling.permissions_yolo = true;
    let yolo = instruction_assembly::tool_permissions(&agent, &ceiling);
    assert_eq!(yolo, vec![rule("project", "deny")]);
    ceiling.project = Some(instruction_assembly::ProjectRole {
        role: ycoding_core::coordination::Role::Master,
        coordinating: true,
    });
    assert_eq!(
        instruction_assembly::tool_permissions(&agent, &ceiling),
        vec![rule("edit", "deny")]
    );
}

fn visible(
    world: &World,
    session: &str,
    agent: &ycoding_schema::agent::Info,
    saved: &[Rule],
) -> (bool, Vec<String>) {
    let ceiling = world.context.ceiling(&id(session), saved).unwrap();
    let permissions = instruction_assembly::tool_permissions(agent, &ceiling);
    let available = world.registry.available(&permissions);
    let defined = world
        .registry
        .materialize(&permissions)
        .definitions
        .iter()
        .filter_map(|definition| definition.name.as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    assert_eq!(
        available.contains(project::NAME),
        defined.iter().any(|name| name == project::NAME),
        "{session}: availability and definitions must agree"
    );
    (
        available.contains(project::NAME),
        available.into_iter().collect(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_is_visible_only_to_exact_master_and_supervisor_roles() {
    let world = world().await;
    let agent = agent::empty("build".into());
    for (session, expected) in [
        ("ses_master", true),
        ("ses_supervisor", true),
        ("ses_member", false),
        ("ses_grandchild", false),
        ("ses_other", false),
        ("ses_absent", false),
    ] {
        let (project, tools) = visible(&world, session, &agent, &[]);
        assert_eq!(project, expected, "{session}");
        assert!(tools.iter().any(|tool| tool == "read"), "{session}");
    }
    assert_eq!(
        world
            .coordination
            .access_of(&id("ses_supervisor"))
            .unwrap()
            .unwrap()
            .role,
        ycoding_core::coordination::Role::Supervisor
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scoping_preserves_agent_permissions_ceilings_and_subagent_restrictions() {
    let world = world().await;
    let mut agent = agent::empty("build".into());
    let (project, tools) = visible(&world, "ses_master", &agent, &[]);
    assert!(project);
    assert!(tools.iter().any(|tool| tool == "subagent"));
    agent.permissions = vec![rule("read", "deny")];
    let (project, tools) = visible(&world, "ses_master", &agent, &[]);
    assert!(project);
    assert!(!tools.iter().any(|tool| tool == "read"));
    agent.permissions = vec![rule(project::NAME, "deny")];
    assert!(!visible(&world, "ses_master", &agent, &[]).0);
    agent.permissions = vec![rule(project::NAME, "allow")];
    assert!(!visible(&world, "ses_member", &agent, &[]).0);
    agent.permissions = vec![];
    assert!(!visible(&world, "ses_master", &agent, &[rule(project::NAME, "deny")]).0);
    let (_, tools) = visible(&world, "ses_master", &agent, &[rule("read", "deny")]);
    assert!(!tools.iter().any(|tool| tool == "read"));
    agent.mode = "subagent".into();
    let (project, tools) = visible(&world, "ses_supervisor", &agent, &[]);
    assert!(project, "a supervisor subagent keeps its Project scope");
    assert!(
        !tools
            .iter()
            .any(|tool| tool == "subagent" || tool == "subagent_control")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn scope_is_resolved_from_current_coordination_state() {
    let world = world().await;
    let agent = agent::empty("build".into());
    assert!(visible(&world, "ses_supervisor", &agent, &[]).0);
    let group = world.coordination.list().unwrap().remove(0);
    world
        .coordination
        .set_owner(
            &group.id,
            OwnerInput {
                session_id: id("ses_member"),
                owner_session_id: None,
                reason: Some(c::ReleaseReason::Released),
            },
        )
        .await
        .unwrap();
    assert!(!visible(&world, "ses_supervisor", &agent, &[]).0);
    assert!(visible(&world, "ses_master", &agent, &[]).0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unbound_project_runtime_fails_closed_without_a_permission_prompt() {
    let world = world().await;
    assert!(world.runtime.get().is_none());
    let settled = tokio::time::timeout(
        Duration::from_secs(5),
        world.registry.materialize(&[]).invoke(
            project::NAME,
            parse_json(r#"{"action":"list"}"#).unwrap(),
            ToolContext::new("ses_master", "god", "msg_project", "call_project").unwrap(),
        ),
    )
    .await
    .expect("an unbound Project tool must settle within 5s");
    assert!(
        !matches!(&settled, Ok(settlement) if settlement.error.is_none()),
        "{settled:?}"
    );
}

#[tokio::test]
async fn project_create_direct_provider_advertises_the_model_object() {
    use ycoding_ai::{auth::Credential, llm::Request, openai_codex};
    use ycoding_schema::JsonValue;

    let world = world().await;
    let tools = world.registry.materialize(&[]);
    let definition = tools
        .definitions
        .iter()
        .find(|tool| tool.name.as_str() == Some("project"))
        .unwrap();
    let model = openai_codex::model(
        "gpt-6.2-sol-fast",
        openai_codex::Config::new(Credential::value("fixture")),
    )
    .unwrap();
    let mut request = Request::new(model);
    request.tools.push(definition.clone());
    let body: serde_json::Value =
        serde_json::from_str(&request.model.route.prepare(&request).unwrap().encoded_body).unwrap();
    let parameters = &body["tools"][0]["parameters"];
    assert_eq!(body["tools"][0]["strict"], false);

    let wrong_model = provider_tool_call(
        &request,
        "invalid",
        r#"{"action":"create","directory":"/","model":"openai/example"}"#,
    )
    .input;
    let result = tools
        .invoke(
            "project",
            wrong_model,
            ToolContext::new("ses_master", "build", "msg_project", "invalid").unwrap(),
        )
        .await
        .unwrap();
    let ycoding_ai::llm::ToolResultValue::Error(JsonValue::String(error)) = result.result else {
        panic!("a model string must fail before the runtime is called: {result:?}");
    };
    eprintln!("direct malformed model: {error:?}");
    assert!(error.to_utf8().unwrap().contains("Expected(\"object\")"));

    let wire = jsonschema::validator_for(parameters).unwrap();
    for placement in [
        r#""directory":"/""#,
        r#""name":"lane","repository":"/""#,
        r#""projectID":"prj_visibility""#,
    ] {
        for selection in [
            r#""providerID":"openai","id":"example""#,
            r#""providerID":"openai","id":"example","variant":"high","profile":"fixture""#,
        ] {
            let input = serde_json::from_str(&format!(
                r#"{{"action":"create",{placement},"model":{{{selection}}}}}"#
            ))
            .unwrap();
            assert!(wire.is_valid(&input), "valid placement with model: {input}");
        }
    }
    for model in [
        serde_json::json!("openai/example"),
        serde_json::Value::Null,
        serde_json::json!({"id":"example"}),
        serde_json::json!({"id":"example","providerID":"openai","variant":null}),
    ] {
        assert!(
            !wire.is_valid(&serde_json::json!({"action":"create","directory":"/","model":model}))
        );
    }
    assert!(
        parameters["properties"]["model"].is_object(),
        "the direct provider's parameter table must expose the model field"
    );

    for (arguments, error) in [
        (
            r#"{"action":"create","directory":"/","model":null}"#,
            "Expected(\"object\")",
        ),
        (
            r#"{"action":"create","directory":"/","model":{"id":"example","providerID":"openai","profile":null}}"#,
            "Expected(\"string\")",
        ),
        (
            r#"{"action":"create","directory":"/","projectID":"prj_visibility"}"#,
            "requires exactly one",
        ),
    ] {
        let result = tools
            .invoke(
                "project",
                parse_json(arguments).unwrap(),
                ToolContext::new("ses_master", "build", "msg_project", "invalid").unwrap(),
            )
            .await
            .unwrap();
        assert!(
            matches!(result.result, ycoding_ai::llm::ToolResultValue::Error(JsonValue::String(message)) if message.to_utf8().unwrap().contains(error))
        );
    }
}

fn provider_tool_call(
    request: &ycoding_ai::llm::Request,
    call_id: &str,
    arguments: &str,
) -> ycoding_ai::llm::ToolCall {
    use serde_json::json;
    use ycoding_ai::llm::Event;

    let mut parser = request.model.route.protocol.parser(request);
    let item = json!({"type":"function_call","id":"item_project","call_id":call_id,"name":"project","arguments":arguments});
    ["response.output_item.added", "response.output_item.done"]
        .into_iter()
        .flat_map(|kind| {
            parser
                .push(&parse_json(&json!({"type":kind,"item":item}).to_string()).unwrap())
                .unwrap()
        })
        .find_map(|event| match event {
            Event::ToolCall(call) => Some(call),
            _ => None,
        })
        .unwrap()
}

#[tokio::test]
async fn project_create_preserves_each_model_in_direct_and_nested_placements() {
    use serde_json::{Value, json};
    use ycoding_ai::{auth::Credential, llm::Request, openai_codex};
    use ycoding_core::{
        coordination::runtime,
        job,
        session::{execution, run_coordinator, store},
    };
    use ycoding_schema::{LosslessString, agent, permission, project, stringify_json};

    struct NoWake;
    impl execution::Locations for NoWake {
        fn get(
            &self,
            _: &session::Info,
        ) -> Result<Arc<dyn execution::Runner>, run_coordinator::Error> {
            panic!("a member without a prompt must not start a runner")
        }
    }

    struct NoDecisions;
    impl runtime::Decisions for NoDecisions {
        fn settings(&self) -> runtime::Future<'_, c::Settings> {
            unreachable!()
        }
        fn pending(&self, _: runtime::PendingInput) -> runtime::Future<'_, Vec<runtime::Pending>> {
            Box::pin(async { Ok(vec![]) })
        }
        fn evaluate(
            &self,
            _: runtime::EvaluateInput,
        ) -> runtime::Future<'_, runtime::DecisionResult> {
            unreachable!()
        }
        fn escalate(
            &self,
            _: runtime::DecisionEscalateInput,
        ) -> runtime::Future<'_, runtime::DecisionEscalateResult> {
            unreachable!()
        }
    }

    struct Placement(String);
    impl runtime::MemberCreator for Placement {
        fn agent_permissions(
            &self,
            _: session::Id,
            _: agent::Id,
        ) -> runtime::Future<'_, Option<permission::Ruleset>> {
            Box::pin(async { Ok(Some(vec![])) })
        }
        fn worktree_allowed(&self, _: session::Id) -> runtime::Future<'_, bool> {
            Box::pin(async { Ok(true) })
        }
        fn create_worktree(
            &self,
            _: runtime::CreateContext,
            name: LosslessString,
            repository: Option<LosslessString>,
        ) -> runtime::Future<'_, runtime::CreatedWorktree> {
            Box::pin(async move {
                assert_eq!(repository, Some(self.0.as_str().into()));
                Ok(runtime::CreatedWorktree {
                    directory: self.0.as_str().into(),
                    branch: name,
                })
            })
        }
        fn directory(
            &self,
            _: runtime::CreateContext,
        ) -> runtime::Future<'_, runtime::CreateDirectory> {
            let directory: LosslessString = self.0.as_str().into();
            Box::pin(async move {
                Ok(runtime::CreateDirectory {
                    home: std::env::temp_dir(),
                    open: Box::new(move |selected, missing| {
                        Box::pin(async move {
                            assert!(!missing);
                            assert_eq!(selected.as_lossless(), &directory);
                            Ok(project::Id::new("prj_visibility").unwrap())
                        })
                    }),
                })
            })
        }
        fn attach_location(
            &self,
            _: runtime::CreateContext,
            _: session::Id,
        ) -> runtime::Future<'_, runtime::AuthorizeLocation> {
            unreachable!()
        }
    }

    let world = world().await;
    let directory = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .into_os_string()
        .into_string()
        .unwrap();
    let sessions = store::Service::new(world._store.client());
    let jobs = job::Jobs::new();
    let execution =
        execution::Execution::install(sessions.clone(), Arc::new(NoWake), jobs.clone(), None)
            .unwrap();
    assert!(
        world
            .runtime
            .set(runtime::Runtime::new(runtime::Options {
                coordination: world.coordination.clone(),
                sessions: sessions.clone(),
                execution,
                jobs,
                decisions: Arc::new(NoDecisions),
                validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
                model_services: Arc::new(|_| unreachable!()),
                creator: Some(Arc::new(Placement(directory.clone()))),
            }))
            .is_ok()
    );

    let tools = world.registry.materialize(&[]);
    let model = openai_codex::model(
        "gpt-6.2-sol-fast",
        openai_codex::Config::new(Credential::value("fixture")),
    )
    .unwrap();
    let request = Request::new(model);
    let context =
        |call_id: &str| ToolContext::new("ses_master", "build", "msg_project", call_id).unwrap();
    let not_master = tools
        .invoke(
            "project",
            parse_json(r#"{"action":"create","projectID":"prj_visibility"}"#).unwrap(),
            ToolContext::new("ses_supervisor", "build", "msg_project", "unauthorized").unwrap(),
        )
        .await
        .unwrap();
    assert!(
        matches!(not_master.result, ycoding_ai::llm::ToolResultValue::Error(ycoding_schema::JsonValue::String(message)) if message.to_utf8().unwrap().contains("Master"))
    );
    let check = |result: &Value, input: &Value| {
        assert_eq!(result["action"], "create");
        assert_eq!(result["directory"], directory);
        assert_eq!(result["model"], input["model"]);
        assert_eq!(result["branch"], input["name"]);
        assert_eq!(result["enrollment"]["member"], true);
        let member = sessions
            .get(&id(result["sessionID"].as_str().unwrap()))
            .unwrap()
            .unwrap();
        assert_eq!(
            member.model,
            Some(model::Ref::decode(&parse_json(&input["model"].to_string()).unwrap()).unwrap())
        );
    };

    for (index, selection) in [
        json!({"providerID":"openai","id":"example"}),
        json!({"providerID":"openai","id":"example","variant":"high","profile":"fixture"}),
    ]
    .into_iter()
    .enumerate()
    {
        let inputs = [
            json!({"action":"create","directory":directory,"model":selection}),
            json!({"action":"create","name":"lane","repository":directory,"model":selection}),
            json!({"action":"create","projectID":"prj_visibility","model":selection}),
        ];
        for (placement, input) in inputs.iter().enumerate() {
            let call_id = format!("direct-{index}-{placement}");
            let call = provider_tool_call(&request, &call_id, &input.to_string());
            let result = tools
                .invoke("project", call.input, context(&call_id))
                .await
                .unwrap();
            let output = result
                .output
                .unwrap_or_else(|| panic!("{input}: {:?}", result.result));
            check(
                &serde_json::from_str(&stringify_json(&output.structured)).unwrap(),
                input,
            );
        }

        let code = format!(
            "const found = (await search({{query: 'project'}})).items[0].path; const results = []; for (const item of {}) {{ results.push(await tools.project(item)); }} return {{found, results}};",
            json!(inputs)
        );
        let start = std::time::Instant::now();
        let result = tools
            .invoke(
                "execute",
                parse_json(&json!({"code":code}).to_string()).unwrap(),
                context(&format!("nested-{index}")),
            )
            .await
            .unwrap();
        eprintln!("three Project creates plus search: {:?}", start.elapsed());
        let ycoding_ai::llm::ToolResultValue::Text(ycoding_schema::JsonValue::String(output)) =
            result.result
        else {
            panic!("{result:?}");
        };
        let output = output.to_utf8().unwrap();
        let output: Value = serde_json::from_str(&output).unwrap_or_else(|_| panic!("{output}"));
        assert_eq!(output["found"], "tools.project");
        assert_eq!(output["results"].as_array().unwrap().len(), inputs.len());
        for (result, input) in output["results"].as_array().unwrap().iter().zip(&inputs) {
            check(result, input);
        }
    }
}

async fn coordination_voice(world: &World, session: &str) -> Option<String> {
    let agent = agent::empty("build".into());
    let ceiling = world.context.ceiling(&id(session), &[]).unwrap();
    let sources = world
        .context
        .sources(vec![], &agent, &ceiling)
        .await
        .unwrap();
    let source = sources.iter().find(|source| {
        ycoding_core::instructions::key(&source.key).as_str() == Some("ycoding/coordination-voice")
    })?;
    match (source.read)().await.unwrap() {
        ycoding_core::instructions::Observation::Value(value) => {
            (source.initial)(&value).map(|text| text.to_utf8().unwrap())
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coordination_instructions_follow_each_sessions_project_role() {
    let world = world().await;
    let master = coordination_voice(&world, "ses_master").await.unwrap();
    assert!(master.starts_with("Project role: Master."), "{master}");
    assert!(master.contains("Coordinate and supervise only"));
    let supervisor = coordination_voice(&world, "ses_supervisor").await.unwrap();
    assert!(
        supervisor.starts_with("Project role: supervisor."),
        "{supervisor}"
    );
    let member = coordination_voice(&world, "ses_member").await.unwrap();
    assert!(member.starts_with("Project role: executor."), "{member}");
    assert!(!member.contains("Coordinate and supervise only"));
    let scout = coordination_voice(&world, "ses_scout").await.unwrap();
    assert!(
        scout.starts_with("Project role: Master's subagent."),
        "{scout}"
    );
    assert!(coordination_voice(&world, "ses_other").await.is_none());
    assert!(coordination_voice(&world, "ses_absent").await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rendered_system_prompts_require_explicit_steer_only_for_coordinators() {
    let world = world().await;
    let agent = agent::empty("build".into());
    let catalog = Catalog::default();
    let selection =
        model::Ref::decode(&parse_json(r#"{"providerID":"openai","id":"gpt-5"}"#).unwrap())
            .unwrap();
    let directives = [
        "As Master, send work instructions to supervisor subagents with `subagent_control`.",
        "As supervisor, send work instructions to owned Project members with `project`.",
        r#"For every such send, including the initial assignment, set `delivery: "steer"` explicitly."#,
        "If a send's outcome is uncertain, check the target's native Session state before retrying. Retry only if you confirm that the instruction was not accepted.",
    ];
    for (session, is_coordinator) in [
        ("ses_master", true),
        ("ses_supervisor", true),
        ("ses_member", false),
    ] {
        let session_id = id(session);
        let ceiling = world.context.ceiling(&session_id, &[]).unwrap();
        let sources = world
            .context
            .sources(vec![], &agent, &ceiling)
            .await
            .unwrap();
        let observed = ycoding_core::instructions::read(&sources).await.unwrap();
        let snapshot = world._store.client().snapshot().unwrap();
        let initial = instruction_assembly::preview(&snapshot, &session_id, &sources, observed)
            .unwrap()
            .initial;
        let system = generate::system(&agent, &catalog, &selection, &[], initial);
        for directive in directives {
            assert_eq!(
                system
                    .iter()
                    .any(|part| part.text.to_utf8().unwrap().contains(directive)),
                is_coordinator,
                "{session}: {directive}"
            );
        }
    }
}
