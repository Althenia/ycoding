use std::{sync::Arc, time::Duration};
use ycoding_core::{
    coordination::{OwnerInput, Service},
    event_feed::Feed,
    resources::{
        agent, config, domain_state::DomainState, mcp, reference, skill, tool_output_store,
    },
    session::instruction_assembly::{self, Context},
    tools::{
        builtin::project::{self, Project},
        context::Context as ToolContext,
        registry::{DynamicTool, Options, Registry, Tool},
    },
};
use ycoding_schema::{
    coordination as c, parse_json,
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
    let store = Store::disposable(
        StoreOptions::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([47; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project_tables::ProjectTable::insert(
                tx,
                &project_tables::Project {
                    id: "prj_visibility".into(),
                    worktree: "/synthetic".into(),
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
