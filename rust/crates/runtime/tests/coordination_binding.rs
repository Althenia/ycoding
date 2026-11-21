#[path = "support/production_owner.rs"]
mod production_owner;

mod support;

use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};
use ycoding_core::{
    coordination::{OwnerInput, runtime::SendInput},
    event_feed::Scope,
    resources::{catalog::models_dev, config},
    tools::{context::Context, registry::Registry},
    ycoding_schema::{coordination as c, model, parse_json, provider, session, stringify_json},
    ycoding_store::{
        Metadata, Options, Store,
        project::{Project, ProjectTable},
        session::{NewEvent, SessionTable, append},
    },
};
use ycoding_runtime::{Core, Production};

const CHILD: &str = "YCODING_COORDINATION_BINDING_CHILD";

fn isolated(test: &str) -> bool {
    if std::env::var_os(CHILD).is_some() {
        return false;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture", "--test-threads", "1"])
        .env(CHILD, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("test result: ok. 1 passed"),
        "isolated {test} ended with {:?}\n{stdout}\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    true
}

struct Fixture {
    root: PathBuf,
    roots: config::Roots,
    core: Core,
    _store: ycoding_core::ycoding_store::Client,
}

impl Fixture {
    async fn open(host: &production_owner::Host, policy: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "coordination-binding-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let roots = config::Roots::development(&root).unwrap();
        roots.initialize().unwrap();
        let directory = root.join("project");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(roots.config.join("ycoding.json"), policy).unwrap();
        let catalog = roots.cache.join("models.json");
        std::fs::write(&catalog, "{}").unwrap();
        let store = host.retain(
            Store::initialize(
                root.join("store.redb"),
                Options::core(),
                ycoding_core::ycoding_store::native::catalog(
                    ycoding_core::ycoding_store::native::DatabaseKind::Core,
                ),
                Metadata::new([5; 16], 1),
            )
            .unwrap(),
            Some(&root),
        );
        let path = directory.to_str().unwrap().to_owned();
        store
            .submit(move |tx| {
                ProjectTable::insert(
                    tx,
                    &Project {
                        id: "prj_one".into(),
                        worktree: path.clone().into(),
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
                for id in ["ses_bind_master", "ses_bind_member", "ses_bind_other"] {
                    let mut row = support::record(id);
                    row.directory = path.clone().into();
                    SessionTable::insert(tx, &row)?;
                }
                Ok(())
            })
            .unwrap()
            .await
            .unwrap();
        let core = Core::production(
            &host.owner,
            store.clone(),
            Production {
                analytics: roots.data.join("analytics"),
                configuration: config::LoadOptions {
                    directory,
                    roots: roots.clone(),
                    project: true,
                    file: None,
                    content: None,
                    env: BTreeMap::new(),
                },
                catalog: models_dev::Options {
                    source: "https://models.dev/api.json".into(),
                    cache: roots.cache.join("catalog.json"),
                    file: Some(catalog),
                    bundled: None,
                    fetch: false,
                    user_agent: "ycoding/test".into(),
                },
                cursor: None,
                steer: None,
                ripgrep: "rg".into(),
                meeting: false,
            },
        )
        .await
        .unwrap();
        Self {
            root,
            roots,
            core,
            _store: store,
        }
    }

    async fn project(&self) -> c::GroupId {
        let input = c::CreateInput {
            name: "Binding".into(),
            master_session_id: session::Id::new("ses_bind_master").unwrap(),
            member_session_ids: vec![session::Id::new("ses_bind_member").unwrap()],
        };
        self.core.coordination.create(input).await.unwrap().id
    }

    async fn finish(self) {
        self.core.shutdown().await.unwrap();
    }
}

async fn project_tool(
    tools: &Registry,
    session: &str,
    call: &str,
) -> ycoding_core::tools::materialization::Settlement {
    let context = Context::new(session, "god", "msg_project_tool", call).unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        tools.materialize(&[]).invoke(
            "project",
            parse_json(r#"{"action":"list"}"#).unwrap(),
            context,
        ),
    )
    .await
    .expect("the project tool must settle within 5s")
    .unwrap()
}

fn default_policy() -> c::Settings {
    c::Settings {
        enabled: true,
        categories: vec![
            c::RequestKind::Question,
            c::RequestKind::Permission,
            c::RequestKind::Review,
        ],
        actions: None,
        resources: None,
        expires_at: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fixture_core_binds_a_runtime_with_the_canonical_default_policy() {
    let runtime = support::world()
        .core
        .coordination_runtime
        .as_ref()
        .expect("Core::new must bind the Project runtime");
    assert_eq!(runtime.settings().await.unwrap(), default_policy());
}

#[test]
fn production_core_reads_the_global_policy_on_every_call_and_fails_closed() {
    if isolated("production_core_reads_the_global_policy_on_every_call_and_fails_closed") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host, "{}").await;
            let runtime = fixture
                .core
                .coordination_runtime
                .clone()
                .expect("production must bind the Project runtime");
            assert_eq!(runtime.settings().await.unwrap(), default_policy());
            let config = fixture.roots.config.join("ycoding.json");
            std::fs::write(
        &config,
        r#"{"coordination":{"delegated_decisions":{"enabled":false,"categories":["question"]}}}"#,
    )
    .unwrap();
            let narrowed = runtime.settings().await.unwrap();
            assert!(!narrowed.enabled);
            assert_eq!(narrowed.categories, vec![c::RequestKind::Question]);
            std::fs::write(
                &config,
                r#"{"coordination":{"delegated_decisions":{"enabled":"yes"}}}"#,
            )
            .unwrap();
            assert!(!runtime.settings().await.unwrap().enabled);
            fixture.finish().await;
        })
    });
}

#[test]
fn production_project_reads_resolve_participants_through_the_target_location() {
    if isolated("production_project_reads_resolve_participants_through_the_target_location") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host, "{}").await;
            let runtime = fixture.core.coordination_runtime.clone().unwrap();
            let id = fixture.project().await;
            let summaries = runtime.summaries().await.unwrap();
            assert!(
                summaries
                    .iter()
                    .any(|summary| summary.id == id && summary.member_count.get() == 1)
            );
            let info = runtime.get(&id).await.unwrap();
            assert_eq!(
                info.master.session_id.as_lossless().as_str(),
                Some("ses_bind_master")
            );
            assert_eq!(info.members.len(), 1);
            assert_eq!(
                info.members[0].session_id.as_lossless().as_str(),
                Some("ses_bind_member")
            );
            assert_eq!(info.members[0].state, c::MemberState::Idle);
            assert_eq!(
                fixture.core.coordination.get(&id).unwrap().revision,
                info.revision
            );
            fixture.finish().await;
        })
    });
}

#[test]
fn production_send_validates_the_model_in_the_member_location_before_admission() {
    if isolated("production_send_validates_the_model_in_the_member_location_before_admission") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host, "{}").await;
            let runtime = fixture.core.coordination_runtime.clone().unwrap();
            let id = fixture.project().await;
            fixture.core.coordination.activate(&id).unwrap();
            let master = session::Id::new("ses_bind_master").unwrap();
            let member = session::Id::new("ses_bind_member").unwrap();
            let error = runtime
                .send(
                    &master,
                    SendInput {
                        session_id: member.clone(),
                        text: "Run the focused checks".into(),
                        delivery: None,
                        message_id: None,
                        model: Some(model::Ref {
                            id: "missing".into(),
                            provider_id: provider::Id("absent".into()),
                            variant: None,
                            profile: None,
                        }),
                    },
                )
                .await
                .unwrap_err();
            assert_eq!(error.reason(), Some("CoordinationRuntime.RefusedError"));
            assert!(error.to_string().contains("is not available for Session"));
            assert!(
                fixture
                    .core
                    .sessions
                    .pending_list(&member)
                    .unwrap()
                    .is_empty()
            );
            fixture.finish().await;
        })
    });
}

#[test]
fn production_worker_turns_member_events_into_master_notices_and_stops_with_the_core() {
    if isolated("production_worker_turns_member_events_into_master_notices_and_stops_with_the_core")
    {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host, "{}").await;
            let id = fixture.project().await;
            let master = session::Id::new("ses_bind_master").unwrap();
            fixture
                .core
                .coordination
                .set_owner(
                    &id,
                    OwnerInput {
                        session_id: session::Id::new("ses_bind_member").unwrap(),
                        owner_session_id: Some(master.clone()),
                        reason: None,
                    },
                )
                .await
                .unwrap();
            let subscribers = fixture.core.events.subscribers();
            let admitted = Arc::new(tokio::sync::Notify::new());
            let wake = admitted.clone();
            let watch = fixture
                .core
                .events
                .subscribe_types(
                    Scope::Session(master.clone()),
                    &["session.input.admitted.1"],
                    move || wake.notify_one(),
                )
                .unwrap();
            fixture
                ._store
                .submit(|tx| {
                    append(
                        tx,
                        &NewEvent {
                            id: "evt_binding_progress".into(),
                            aggregate_id: "ses_bind_member".into(),
                            created: 2,
                            type_: "session.step.ended.1".into(),
                            data: parse_json(r#"{"sessionID":"ses_bind_member"}"#).unwrap(),
                        },
                        None,
                    )?;
                    Ok(())
                })
                .unwrap()
                .await
                .unwrap();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            let notified = |sessions: &ycoding_core::session::store::Service| {
                sessions
                    .pending_list(&master)
                    .unwrap()
                    .iter()
                    .any(|pending| {
                        pending
                            .id
                            .as_str()
                            .is_some_and(|id| id.starts_with("msg_project_notice_"))
                    })
            };
            while !notified(&fixture.core.sessions) {
                tokio::time::timeout_at(deadline, admitted.notified())
                    .await
                    .expect("the live worker must deliver the member notice to Main within 5s");
            }
            drop(watch);
            assert!(fixture.core.coordination.get(&id).is_ok());
            let events = fixture.core.events.clone();
            fixture.finish().await;
            assert!(events.subscribers() < subscribers);
        })
    });
}

#[test]
fn production_registry_serves_the_shared_project_tool_and_refuses_unscoped_callers() {
    if isolated("production_registry_serves_the_shared_project_tool_and_refuses_unscoped_callers") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host, "{}").await;
            fixture.project().await;
            let directory = fixture.root.join("project").to_str().unwrap().to_owned();
            let services = fixture
                .core
                .locations
                .location(&directory.into(), None)
                .unwrap();
            let tools = &services.production.as_ref().unwrap().tools;
            assert!(tools.available(&[]).contains("project"));
            let listed = project_tool(tools, "ses_bind_master", "call_project_list").await;
            assert!(listed.error.is_none(), "{:?}", listed.error);
            let output = stringify_json(&listed.output.unwrap().structured);
            assert!(output.contains("ses_bind_member"), "{output}");
            let refused = project_tool(tools, "ses_bind_other", "call_project_refused").await;
            assert!(refused.error.is_some());
            fixture.finish().await;
        })
    });
}

#[test]
fn production_reload_binds_the_same_project_runtime_into_the_new_registry() {
    if isolated("production_reload_binds_the_same_project_runtime_into_the_new_registry") {
        return;
    }
    production_owner::run(|host| {
        Box::pin(async move {
            let fixture = Fixture::open(host, "{}").await;
            fixture.project().await;
            let directory = fixture.root.join("project").to_str().unwrap().to_owned();
            let services = fixture
                .core
                .locations
                .location(&directory.into(), None)
                .unwrap();
            let before = services.production.as_ref().unwrap().tools.clone();
            let info = services.info.clone();
            fixture.core.locations.reload(&info).unwrap();
            let (_, reloaded) = fixture
                .core
                .locations
                .session(&session::Id::new("ses_bind_master").unwrap())
                .unwrap();
            let after = &reloaded.production.as_ref().unwrap().tools;
            assert!(
                !Arc::ptr_eq(after, &before),
                "reload must compose a new registry"
            );
            assert!(after.available(&[]).contains("project"));
            let listed = project_tool(after, "ses_bind_master", "call_project_reloaded").await;
            assert!(listed.error.is_none(), "{:?}", listed.error);
            let output = stringify_json(&listed.output.unwrap().structured);
            assert!(output.contains("ses_bind_member"), "{output}");
            let refused =
                project_tool(after, "ses_bind_other", "call_project_reload_refused").await;
            assert!(refused.error.is_some());
            fixture.finish().await;
        })
    });
}
