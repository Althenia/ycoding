include!("policy_fixture.rs");

use std::sync::{Arc, atomic::AtomicUsize};
use ycoding_core::{
    coordination::{
        self, Service,
        runtime::{
            CreateInput, CreatedWorktree, DecisionEscalateInput, DecisionEscalateResult,
            DecisionResult, Decisions, EvaluateInput, Future, Options, Pending, PendingInput,
            Runtime,
        },
    },
    event_feed::Feed,
    job,
    session::{
        autonomy::{DecisionChange, DecisionMode, Service as Autonomy},
        execution::{Execution, Locations, Runner},
        run_coordinator::{DrainRequest, RunFuture},
        store::Service as SessionStore,
    },
};
use ycoding_schema::{coordination as c, parse_json, permission, session};
use ycoding_store::session::{Document, Task, TaskTable};

fn sid(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

struct NoDecisions;
impl Decisions for NoDecisions {
    fn settings(&self) -> Future<'_, c::Settings> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn pending(&self, _input: PendingInput) -> Future<'_, Vec<Pending>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn evaluate(&self, _input: EvaluateInput) -> Future<'_, DecisionResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn escalate(&self, _input: DecisionEscalateInput) -> Future<'_, DecisionEscalateResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
}

struct Park;
impl Runner for Park {
    fn drain(&self, _request: DrainRequest) -> RunFuture {
        Box::pin(async {
            std::future::pending::<()>().await;
            Ok(())
        })
    }
}
struct Counted(Arc<AtomicUsize>);
impl Locations for Counted {
    fn get(
        &self,
        _session: &ycoding_schema::session::Info,
    ) -> Result<Arc<dyn Runner>, ycoding_core::session::run_coordinator::Error> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(Arc::new(Park))
    }
}

const MASTER_MODES: (DecisionMode, DecisionMode, DecisionMode) =
    (DecisionMode::Auto, DecisionMode::Auto, DecisionMode::Yolo);

struct World {
    fixture: Fixture,
    service: Service,
    autonomy: Autonomy,
}

fn world(members: &[&str]) -> World {
    let fixture = Fixture::default();
    fixture.session_with("ses_master", None, ["manual"; 3], false, None);
    for member in members {
        fixture.session_with(member, None, ["manual"; 3], false, None);
    }
    let client = fixture.store.client();
    let service = Service::new(client.clone(), Feed::attach(&client));
    let autonomy = Autonomy::new(client);
    World {
        fixture,
        service,
        autonomy,
    }
}

async fn promote_master(world: &World) {
    world
        .autonomy
        .set_decisions(
            &sid("ses_master"),
            DecisionChange::new(
                Some(MASTER_MODES.0),
                Some(MASTER_MODES.1),
                Some(MASTER_MODES.2),
            )
            .unwrap(),
        )
        .await
        .unwrap();
}

fn modes(world: &World, id: &str) -> (DecisionMode, DecisionMode, DecisionMode) {
    let effective = world.autonomy.effective(&sid(id)).unwrap();
    (
        effective.permissions,
        effective.guardrails,
        effective.answers,
    )
}

const MANUAL: (DecisionMode, DecisionMode, DecisionMode) = (
    DecisionMode::Manual,
    DecisionMode::Manual,
    DecisionMode::Manual,
);

#[tokio::test]
async fn yolo_reconciliation_rejects_an_existing_permission_after_its_session_becomes_a_coordinator()
 {
    let world = world(&["ses_member"]);
    let permissions = world.fixture.permissions();
    let request = permission::Request {
        id: permission::Id::new("per_pending_project").unwrap(),
        session_id: sid("ses_master"),
        action: "edit".into(),
        resources: vec!["notes/plan.md".into()],
        save: None,
        metadata: None,
        source: None,
        escalation: None,
        coordination_escalation: None,
    };
    let wait = permissions
        .ask(request, None)
        .unwrap()
        .wait
        .expect("a Manual edit waits");
    world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_member")],
        })
        .await
        .unwrap();
    world
        .autonomy
        .set_decisions(
            &sid("ses_master"),
            DecisionChange::new(Some(DecisionMode::Yolo), None, None).unwrap(),
        )
        .await
        .unwrap();
    permissions.reconcile_autonomy(&sid("ses_master")).unwrap();
    assert!(permissions.list().is_empty());
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), wait)
        .await
        .unwrap()
        .unwrap();
    let Err(ycoding_core::tools::policy::permissions::Error::Corrected(feedback)) = outcome else {
        panic!("a coordinator-blocked ask is returned as corrective feedback: {outcome:?}")
    };
    assert_eq!(
        feedback.to_utf8().unwrap(),
        "Permission denied: edit. This Session is a Project coordinator; member Sessions make Project changes."
    );
    let replied = world
        .fixture
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event.type_ == "permission.replied")
        .map(|event| ycoding_schema::stringify_json(&event.data))
        .collect::<Vec<_>>();
    assert_eq!(replied.len(), 1);
    assert!(replied[0].contains("\"reject\""));
    permissions.reconcile_autonomy(&sid("ses_master")).unwrap();
    assert!(permissions.list().is_empty());
}

#[tokio::test]
async fn creating_a_project_with_members_gives_each_member_the_masters_modes() {
    let world = world(&["ses_alpha", "ses_beta"]);
    promote_master(&world).await;
    world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha"), sid("ses_beta")],
        })
        .await
        .unwrap();
    assert_eq!(modes(&world, "ses_alpha"), MASTER_MODES);
    assert_eq!(modes(&world, "ses_beta"), MASTER_MODES);
}

#[tokio::test]
async fn updating_a_project_gives_only_newly_added_members_the_masters_modes() {
    let world = world(&["ses_alpha", "ses_beta", "ses_gamma"]);
    let group = world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha")],
        })
        .await
        .unwrap();
    promote_master(&world).await;
    let update = |revision, members: &[&str]| c::UpdateInput {
        revision: c::Revision::new(revision).unwrap(),
        name: None,
        master_session_id: None,
        member_session_ids: Some(members.iter().map(|id| sid(id)).collect()),
        settings: None,
    };
    let added = world
        .service
        .update(
            &group.id,
            update(group.revision.get(), &["ses_alpha", "ses_beta"]),
        )
        .await
        .unwrap();
    assert_eq!(modes(&world, "ses_beta"), MASTER_MODES);
    assert_eq!(
        modes(&world, "ses_alpha"),
        MANUAL,
        "an existing member keeps its own modes"
    );
    world
        .autonomy
        .set_decisions(
            &sid("ses_beta"),
            DecisionChange::new(
                Some(DecisionMode::Manual),
                Some(DecisionMode::Manual),
                Some(DecisionMode::Manual),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    world
        .service
        .update(
            &group.id,
            update(
                added.revision.get(),
                &["ses_alpha", "ses_beta", "ses_gamma"],
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        modes(&world, "ses_beta"),
        MANUAL,
        "a later explicit choice persists across updates"
    );
    assert_eq!(modes(&world, "ses_gamma"), MASTER_MODES);
}

#[tokio::test]
async fn replacing_the_master_leaves_existing_members_unchanged_and_goal_and_sleep_are_not_copied()
{
    let world = world(&["ses_alpha"]);
    world
        .fixture
        .session_with("ses_new_master", None, ["auto", "auto", "yolo"], true, None);
    let group = world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha")],
        })
        .await
        .unwrap();
    world
        .service
        .update(
            &group.id,
            c::UpdateInput {
                revision: group.revision,
                name: None,
                master_session_id: Some(sid("ses_new_master")),
                member_session_ids: None,
                settings: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(modes(&world, "ses_alpha"), MANUAL);

    let joined = world
        .fixture
        .session_with("ses_joined", None, ["manual"; 3], false, None);
    let current = world.service.get(&group.id).unwrap();
    world
        .service
        .add_member(&group.id, joined.clone(), None, false)
        .await
        .unwrap();
    assert_eq!(current.master_session_id, sid("ses_new_master"));
    assert_eq!(modes(&world, "ses_joined"), MASTER_MODES);
    let state = world.autonomy.get(&joined).unwrap();
    assert!(
        state.goal.as_ref().is_none_or(|goal| !goal.is_active()),
        "the Master's active goal is not copied"
    );
    assert!(!state.defer);
}

#[tokio::test]
async fn an_attached_session_keeps_its_own_modes_while_a_created_member_takes_the_masters() {
    let world = world(&["ses_alpha"]);
    promote_master(&world).await;
    let group = world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha")],
        })
        .await
        .unwrap();
    let attached = world
        .fixture
        .session_with("ses_attached", None, ["manual"; 3], false, None);
    let joined = world
        .fixture
        .session_with("ses_joined", None, ["manual"; 3], false, None);
    world
        .service
        .add_member(&group.id, attached.clone(), None, true)
        .await
        .unwrap();
    world
        .service
        .add_member(&group.id, joined.clone(), None, false)
        .await
        .unwrap();
    let members = world.service.get(&group.id).unwrap().member_session_ids;
    assert!(members.contains(&attached) && members.contains(&joined));
    assert_eq!(modes(&world, "ses_attached"), MANUAL);
    assert_eq!(modes(&world, "ses_joined"), MASTER_MODES);
}

#[tokio::test]
async fn a_member_subagent_inherits_the_modes_the_member_took_from_the_master() {
    let world = world(&["ses_alpha"]);
    promote_master(&world).await;
    world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha")],
        })
        .await
        .unwrap();
    world.fixture.session_with(
        "ses_alpha_child",
        Some("ses_alpha"),
        ["manual"; 3],
        false,
        None,
    );
    let task = Task {
        session_id: "ses_alpha_child".into(),
        parent_id: "ses_alpha".into(),
        parent_assistant_message_id: "msg_parent".into(),
        tool_call_id: "call_child".into(),
        input_id: "msg_input_child".into(),
        description: "Work".into(),
        agent: "test".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "0".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: "running".into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        usage_anchor: None,
        attempt_started: 0,
        owner_pid: None,
        owner_started: None,
        revision: 1,
        time_created: 1,
        time_updated: 1,
    };
    world
        .fixture
        .store
        .submit(move |tx| TaskTable::put(tx, &task))
        .unwrap()
        .wait()
        .unwrap();
    let resolved = world.autonomy.resolve(&sid("ses_alpha_child")).unwrap();
    assert_eq!(
        (
            resolved.effective.permissions,
            resolved.effective.guardrails,
            resolved.effective.answers
        ),
        MASTER_MODES
    );
    assert_eq!(resolved.inherited.permissions, Some("ses_alpha".into()));
    assert_eq!(resolved.inherited.guardrails, Some("ses_alpha".into()));
    assert_eq!(resolved.inherited.answers, Some("ses_alpha".into()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_member_created_by_the_master_starts_with_the_masters_effective_modes() {
    let world = world(&[]);
    let group = world
        .service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![],
        })
        .await
        .unwrap();
    world.service.activate(&group.id).unwrap();
    promote_master(&world).await;
    let client = world.fixture.store.client();
    let sessions = SessionStore::new(client);
    let jobs = job::Jobs::new();
    let execution = Execution::install(
        sessions.clone(),
        Arc::new(Counted(Arc::new(AtomicUsize::new(0)))),
        jobs.clone(),
        None,
    )
    .unwrap();
    let runtime = Runtime::new(Options {
        coordination: world.service.clone(),
        sessions,
        execution,
        decisions: Arc::new(NoDecisions),
        jobs,
        validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
        model_services: Arc::new(|_| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model switching is outside this autonomy fixture",
                ))
            })
        }),
        creator: None,
    });
    let created = runtime
        .create(
            &sid("ses_master"),
            CreateInput {
                id: sid("ses_lane_member"),
                agent_permissions: permission::Ruleset::default(),
                target: coordination::runtime::CreateTarget::Worktree {
                    name: "lane-member".into(),
                    repository: None,
                },
                owner_session_id: None,
                title: None,
                prompt: None,
                model: None,
            },
            Some(coordination::runtime::CreateProvider::Worktree(Box::new(
                |name| {
                    Box::pin(async move {
                        Ok(CreatedWorktree {
                            directory: format!("/synthetic/{}", name.as_str().unwrap())
                                .as_str()
                                .into(),
                            branch: name,
                        })
                    }) as Future<'static, CreatedWorktree>
                },
            ))),
        )
        .await
        .unwrap();
    assert!(
        world
            .service
            .get(&group.id)
            .unwrap()
            .member_session_ids
            .contains(&created.session_id)
    );
    let effective = world.autonomy.effective(&created.session_id).unwrap();
    assert_eq!(
        (
            effective.permissions,
            effective.guardrails,
            effective.answers
        ),
        MASTER_MODES
    );
    execution.shutdown().await.unwrap();
}

#[tokio::test]
async fn the_updated_event_is_published_only_after_a_joining_member_holds_the_masters_modes() {
    let fixture = Fixture::default();
    for id in ["ses_master", "ses_alpha", "ses_beta", "ses_gamma"] {
        fixture.session_with(id, None, ["manual"; 3], false, None);
    }
    let client = fixture.store.client();
    let feed = Feed::attach(&client);
    let service = Service::new(client.clone(), feed.clone());
    let autonomy = Autonomy::new(client.clone());
    autonomy
        .set_decisions(
            &sid("ses_master"),
            DecisionChange::new(
                Some(MASTER_MODES.0),
                Some(MASTER_MODES.1),
                Some(MASTER_MODES.2),
            )
            .unwrap(),
        )
        .await
        .unwrap();
    let watched = Arc::new(std::sync::Mutex::new(sid("ses_alpha")));
    let observed = Arc::new(std::sync::Mutex::new(Vec::new()));
    let reader = Autonomy::new(client);
    let _subscriber = feed
        .subscribe_types(
            ycoding_core::event_feed::Scope::Global,
            &["coordination.updated"],
            {
                let watched = Arc::clone(&watched);
                let observed = Arc::clone(&observed);
                move || {
                    let member = watched.lock().unwrap().clone();
                    let effective = reader.effective(&member).unwrap();
                    observed.lock().unwrap().push((
                        effective.permissions,
                        effective.guardrails,
                        effective.answers,
                    ));
                }
            },
        )
        .unwrap();
    let phase = |member: &str| {
        *watched.lock().unwrap() = sid(member);
        observed.lock().unwrap().clear();
    };
    let published = || {
        let seen = observed.lock().unwrap().clone();
        assert!(!seen.is_empty(), "the Updated event was published");
        assert!(
            seen.iter().all(|modes| *modes == MASTER_MODES),
            "the event preceded the member's autonomy copy: {seen:?}"
        );
    };

    phase("ses_alpha");
    let group = service
        .create(c::CreateInput {
            name: "Docs".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha")],
        })
        .await
        .unwrap();
    published();

    phase("ses_beta");
    let added = service
        .add_member(&group.id, sid("ses_beta"), None, false)
        .await
        .unwrap();
    published();

    phase("ses_gamma");
    service
        .update(
            &group.id,
            c::UpdateInput {
                revision: added.revision,
                name: None,
                master_session_id: None,
                member_session_ids: Some(vec![sid("ses_alpha"), sid("ses_beta"), sid("ses_gamma")]),
                settings: None,
            },
        )
        .await
        .unwrap();
    published();
}
