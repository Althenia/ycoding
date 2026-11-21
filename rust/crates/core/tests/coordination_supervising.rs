use std::{
    ops::Bound,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::{
    coordination::{
        self, Service,
        runtime::{
            AssignInput, CreateInput, CreatePrompt, CreatedWorktree, Options, ReleaseInput, Runtime,
        },
    },
    event_feed::{Feed, Payload},
    job,
    session::{
        execution::Execution, orchestration, outstanding, run_coordinator::RunFuture,
        store::Service as SessionStore,
    },
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, ObjectEncoder, coordination as c, parse_json,
    permission, session,
};
use ycoding_store::{
    IndexOrder, IndexQuery, KeyPart, Metadata, Options as StoreOptions, Store,
    native::{self, DatabaseKind},
    project, session as tables,
    session::Document,
    tuple_key,
};

fn key(id: &str) -> Vec<u8> {
    tuple_key(&[KeyPart::String(&id.into())])
}

fn row(id: &str, parent: Option<&str>) -> tables::Session {
    tables::Session {
        id: id.into(),
        project_id: "prj_u5".into(),
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

const SESSIONS: [(&str, Option<&str>); 8] = [
    ("ses_master", None),
    ("ses_alpha", None),
    ("ses_beta", None),
    ("ses_gamma", None),
    ("ses_owner_a", Some("ses_master")),
    ("ses_owner_b", Some("ses_master")),
    ("ses_root", None),
    ("ses_mid", Some("ses_root")),
];

fn fixture() -> (Store, Service, Feed) {
    let store = Store::disposable(
        StoreOptions::core(),
        native::catalog(DatabaseKind::Core),
        Metadata::new([41; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_u5".into(),
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
            for (id, parent) in SESSIONS {
                tables::SessionTable::insert(tx, &row(id, parent))?;
            }
            let mut leaf = row("ses_leaf", Some("ses_mid"));
            leaf.id = "ses_leaf".into();
            tables::SessionTable::insert(tx, &leaf)?;
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    let feed = Feed::attach(&store.client());
    let service = Service::new(store.client(), feed.clone());
    (store, service, feed)
}

fn task(session_id: &str, parent_id: &str, state: &str) -> tables::Task {
    tables::Task {
        session_id: session_id.into(),
        parent_id: parent_id.into(),
        parent_assistant_message_id: "msg_parent".into(),
        tool_call_id: format!("call_{session_id}").as_str().into(),
        input_id: format!("msg_input_{session_id}").as_str().into(),
        description: "Work".into(),
        agent: "test".into(),
        model: Document::new(parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap()).unwrap(),
        prompt_digest: "0".repeat(64).as_str().into(),
        background: 1,
        delivery: "steer".into(),
        state: state.into(),
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
    }
}

fn put_task(store: &Store, row: tables::Task) {
    store
        .submit(move |tx| tables::TaskTable::put(tx, &row))
        .unwrap()
        .wait()
        .unwrap();
}

fn set_task_state(store: &Store, session_id: &str, state: &str) {
    let session_id = session_id.to_owned();
    let state = state.to_owned();
    store
        .submit(move |tx| {
            let mut row = tx.get::<tables::TaskTable>(&key(&session_id))?.unwrap();
            row.state = state.as_str().into();
            tables::TaskTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
}

fn task_state(store: &Store, session_id: &str) -> String {
    store
        .snapshot()
        .unwrap()
        .get::<tables::TaskTable>(&key(session_id))
        .unwrap()
        .unwrap()
        .state
        .as_str()
        .unwrap()
        .to_owned()
}

fn sid(value: &str) -> session::Id {
    session::Id::new(value).unwrap()
}

struct Controls;
impl coordination::runtime::Decisions for Controls {
    fn settings(&self) -> coordination::runtime::Future<'_, c::Settings> {
        Box::pin(async {
            Ok(c::Settings {
                enabled: true,
                categories: vec![c::RequestKind::Permission],
                actions: None,
                resources: None,
                expires_at: None,
            })
        })
    }
    fn pending(
        &self,
        input: coordination::runtime::PendingInput,
    ) -> coordination::runtime::Future<'_, Vec<coordination::runtime::Pending>> {
        Box::pin(async move {
            use coordination::runtime::{Delegation, Pending, RequestDetail};
            let target = input.target_session_id.as_lossless().clone();
            if !matches!(target.as_str(), Some("ses_alpha" | "ses_beta")) {
                return Ok(vec![]);
            }
            let request_id = ycoding_schema::LosslessString::from(
                format!("per_{}", target.as_str().unwrap()).as_str(),
            );
            Ok(vec![Pending {
                summary: c::PendingRequest {
                    kind: c::RequestKind::Permission,
                    request_id: request_id.clone(),
                    fingerprint: "fingerprint".into(),
                    summary: "shell: synthetic-resource".into(),
                    request_session_id: None,
                },
                detail: RequestDetail::Permission {
                    request_id,
                    fingerprint: "fingerprint".into(),
                    action: "shell".into(),
                    resources: vec!["synthetic-resource".into()],
                    delegation: Delegation::Routine,
                    coordination_escalation: None,
                    request_session_id: None,
                },
            }])
        })
    }
    fn evaluate(
        &self,
        _input: coordination::runtime::EvaluateInput,
    ) -> coordination::runtime::Future<'_, coordination::runtime::DecisionResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
    fn escalate(
        &self,
        _input: coordination::runtime::DecisionEscalateInput,
    ) -> coordination::runtime::Future<'_, coordination::runtime::DecisionEscalateResult> {
        Box::pin(async { Err(coordination::Error::refused("outside this fixture")) })
    }
}

struct Park;
impl ycoding_core::session::execution::Runner for Park {
    fn drain(&self, _request: ycoding_core::session::run_coordinator::DrainRequest) -> RunFuture {
        Box::pin(async {
            std::future::pending::<()>().await;
            Ok(())
        })
    }
}

struct NoWake(Arc<AtomicUsize>);
impl ycoding_core::session::execution::Locations for NoWake {
    fn get(
        &self,
        _session: &ycoding_schema::session::Info,
    ) -> Result<
        Arc<dyn ycoding_core::session::execution::Runner>,
        ycoding_core::session::run_coordinator::Error,
    > {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(Arc::new(Park))
    }
}

fn member_event(
    store: &Store,
    id: &str,
    aggregate: &str,
    kind: &str,
    data: JsonValue,
) -> tables::Event {
    let request = tables::NewEvent {
        id: id.into(),
        aggregate_id: aggregate.into(),
        created: chrono::Utc::now().timestamp_millis(),
        type_: kind.into(),
        data,
    };
    store
        .submit(move |tx| {
            let tables::Append::Appended(event) = tables::append(tx, &request, None)? else {
                return Err(ycoding_store::Error::Rejected("expected fixture event"));
            };
            Ok(event)
        })
        .unwrap()
        .wait()
        .unwrap()
}

fn session_data(session_id: &str) -> JsonValue {
    ObjectEncoder::new()
        .field("sessionID", &sid(session_id))
        .finish()
}

fn failed_data(session_id: &str, message: &str) -> JsonValue {
    ObjectEncoder::new()
        .field("sessionID", &sid(session_id))
        .field(
            "error",
            &ycoding_schema::session_error::Error {
                r#type: "provider.error".into(),
                message: message.into(),
            },
        )
        .finish()
}

fn pending_metadata(sessions: &SessionStore, id: &str) -> Vec<JsonValue> {
    sessions
        .pending_list(&sid(id))
        .unwrap()
        .into_iter()
        .map(|row| {
            let JsonValue::Object(data) = row.data else {
                panic!("pending data must be an object")
            };
            data.get(&"metadata".into())
                .cloned()
                .unwrap_or(JsonValue::Null)
        })
        .collect()
}

fn metadata_field(value: &JsonValue, field: &str) -> Option<String> {
    let JsonValue::Object(fields) = value else {
        return None;
    };
    match fields.get(&field.into()) {
        Some(JsonValue::String(text)) => text.as_str().map(str::to_owned),
        _ => None,
    }
}

fn notices_with(sessions: &SessionStore, id: &str, event: &str) -> Vec<JsonValue> {
    pending_metadata(sessions, id)
        .into_iter()
        .filter(|metadata| metadata_field(metadata, "event").as_deref() == Some(event))
        .collect()
}

fn owner_changed_event(store: &Store, group: &c::GroupId) -> tables::Event {
    let prefix = key(group.as_lossless().as_str().unwrap());
    store
        .snapshot()
        .unwrap()
        .index_range::<tables::EventTable>(
            "event_aggregate_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Descending,
                after: None,
                limit: 32,
            },
        )
        .unwrap()
        .into_iter()
        .map(|entry| entry.record)
        .find(|event| event.type_.as_str() == Some("coordination.member.owner.changed.1"))
        .unwrap()
}

fn rules(json: &str) -> permission::Ruleset {
    permission::Ruleset::decode(&parse_json(json).unwrap()).unwrap()
}

#[test]
fn u5_effective_denies_drop_only_denies_shadowed_by_a_later_nondenial_rule() {
    let check =
        |json: &str| ycoding_core::session::orchestration::effective_denies(&rules(json)).encode();
    let deny = |action: &str, resource: &str| {
        parse_json(&format!(
            r#"[{{"action":"{action}","resource":"{resource}","effect":"deny"}}]"#
        ))
        .unwrap()
    };
    assert_eq!(
        check(
            r#"[{"action":"question","resource":"*","effect":"deny"},{"action":"question","resource":"*","effect":"allow"}]"#
        ),
        parse_json("[]").unwrap()
    );
    assert_eq!(
        check(
            r#"[{"action":"question","resource":"*","effect":"deny"},{"action":"question","resource":"*","effect":"ask"}]"#
        ),
        parse_json("[]").unwrap()
    );
    assert_eq!(
        check(
            r#"[{"action":"question","resource":"*","effect":"allow"},{"action":"question","resource":"*","effect":"deny"}]"#
        ),
        deny("question", "*")
    );
    assert_eq!(
        check(
            r#"[{"action":"shell","resource":"a*","effect":"deny"},{"action":"shell","resource":"a?","effect":"allow"}]"#
        ),
        deny("shell", "a*")
    );
    assert_eq!(
        check(
            r#"[{"action":"shell","resource":"a*","effect":"deny"},{"action":"shell","resource":"*","effect":"allow"}]"#
        ),
        parse_json("[]").unwrap()
    );
    assert_eq!(
        check(
            r#"[{"action":"*","resource":"*","effect":"deny"},{"action":"shell","resource":"*","effect":"allow"}]"#
        ),
        deny("*", "*")
    );
    assert_eq!(
        check(r#"[{"action":"question","resource":"*","effect":"deny"},{"action":"plan_exit","resource":"*","effect":"deny"},{"action":"webfetch","resource":"*","effect":"deny"},{"action":"question","resource":"*","effect":"allow"}]"#),
        parse_json(r#"[{"action":"plan_exit","resource":"*","effect":"deny"},{"action":"webfetch","resource":"*","effect":"deny"}]"#).unwrap()
    );
}

struct Recorder;
impl orchestration::Execution for Recorder {
    fn wake(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::Outcome {
        Ok(())
    }
    fn resume(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
    fn interrupt(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn u5_outstanding_propagates_running_to_ancestors_and_supervising_is_unfinished_not_running()
{
    let (store, _service, _feed) = fixture();
    let sessions = SessionStore::new(store.client());
    let orchestration = orchestration::Service::new(sessions.clone(), Arc::new(Recorder));
    let jobs = job::Jobs::new();
    put_task(&store, task("ses_leaf", "ses_mid", "waiting"));
    for state in [
        "starting",
        "running",
        "cancelling",
        "waiting",
        "supervising",
    ] {
        set_task_state(&store, "ses_leaf", state);
        let work = outstanding::read(&sessions, &orchestration, &jobs, &[], false).unwrap();
        for id in ["ses_root", "ses_mid", "ses_leaf"] {
            assert!(
                work.sessions
                    .contains(&ycoding_schema::LosslessString::from(id)),
                "{state}: {id} must be unfinished"
            );
            assert_eq!(
                work.running
                    .contains(&ycoding_schema::LosslessString::from(id)),
                ["starting", "running", "cancelling"].contains(&state),
                "{state}: {id} running"
            );
            assert_eq!(
                work.waiting
                    .contains(&ycoding_schema::LosslessString::from(id)),
                state == "waiting",
                "{state}: {id} waiting"
            );
        }
    }
    set_task_state(&store, "ses_leaf", "completed");
    let (release, held) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "sessionID".into(),
        serde_json::Value::String("ses_leaf".into()),
    );
    let info = jobs
        .start(job::StartInput {
            id: Some("job_u5_shell".into()),
            kind: "shell".into(),
            title: None,
            metadata: Some(metadata),
            run: Box::pin(async move { held.await.unwrap_or_else(|_| Ok("done".into())) }),
        })
        .unwrap();
    jobs.background(&info.id);
    let work = outstanding::read(&sessions, &orchestration, &jobs, &[], false).unwrap();
    for id in ["ses_root", "ses_mid", "ses_leaf"] {
        assert!(
            work.running
                .contains(&ycoding_schema::LosslessString::from(id)),
            "shell: {id} must be running"
        );
    }
    release.send(Ok("done".into())).unwrap();
    jobs.wait(&info.id, None).await;
    let work = outstanding::read(&sessions, &orchestration, &jobs, &[], false).unwrap();
    assert!(
        work.running.is_empty(),
        "settled shell is not running: {work:?}"
    );
    assert!(
        work.sessions
            .contains(&ycoding_schema::LosslessString::from("ses_root")),
        "settled shell notice still owes ancestors: {work:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn u5_runtime_owner_routing_supervising_lifecycle_and_member_creation() {
    use ycoding_core::resources::{
        attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    };
    use ycoding_schema::credential as credential_schema;

    let (store, coordination, _feed) = fixture();
    put_task(&store, task("ses_owner_a", "ses_master", "running"));
    put_task(&store, task("ses_owner_b", "ses_master", "running"));
    let group = coordination
        .create(c::CreateInput {
            name: "U5".into(),
            master_session_id: sid("ses_master"),
            member_session_ids: vec![sid("ses_alpha"), sid("ses_beta"), sid("ses_gamma")],
        })
        .await
        .unwrap();
    coordination.activate(&group.id).unwrap();
    let sessions = SessionStore::new(store.client());
    let jobs = job::Jobs::new();
    let wakes = Arc::new(AtomicUsize::new(0));
    let execution = Execution::install(
        sessions.clone(),
        Arc::new(NoWake(wakes.clone())),
        jobs.clone(),
        None,
    )
    .unwrap();
    let root = std::env::temp_dir().join(format!(
        "ycoding-coordination-controls-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let root = std::fs::canonicalize(root).unwrap();
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog
        .configure(&[parse_json(
            r#"{"providers":{"openai":{"package":"@ycoding-ai/ai/providers/openai"}}}"#,
        )
        .unwrap()])
        .unwrap();
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "coordination-work".into(),
            "openai".into(),
            Some("Work".into()),
            ycoding_store::resources::Secret::new(
                credential_schema::Value::Key(credential_schema::Key {
                    key: "synthetic-coordination-key".into(),
                    metadata: None,
                })
                .encode(),
            )
            .unwrap(),
            1,
        )
        .await
        .unwrap();
    let resolver = orchestration::ModelSwitch::new(
        sessions.clone(),
        Arc::new(model::Resolver::new(catalog)),
        credentials,
        Default::default(),
        Arc::new(attachment_store::Store::new(root.join("attachments")).unwrap()),
    );
    let runtime = Runtime::new(Options {
        coordination: coordination.clone(),
        sessions: sessions.clone(),
        execution,
        decisions: Arc::new(Controls),
        jobs,
        validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
        model_services: Arc::new(move |_| {
            let resolver = resolver.clone();
            Box::pin(async move {
                Ok(coordination::runtime::ModelServices {
                    resolver,
                    lease: Arc::new(()),
                    is_current: Arc::new(|| true),
                })
            })
        }),
        creator: None,
    });
    let master = sid("ses_master");
    let alpha = sid("ses_alpha");
    let beta = sid("ses_beta");
    let gamma = sid("ses_gamma");
    let owner_a = sid("ses_owner_a");
    let owner_b = sid("ses_owner_b");

    runtime
        .assign(
            &master,
            AssignInput {
                session_id: alpha.clone(),
                owner_session_id: owner_a.clone(),
            },
        )
        .await
        .unwrap();
    let refused = runtime
        .release(
            &owner_a,
            ReleaseInput {
                session_id: alpha.clone(),
                reason: c::ReleaseReason::Released,
            },
        )
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("Master releases"), "{refused}");
    set_task_state(&store, "ses_owner_b", "failed");
    let refused = runtime
        .assign(
            &master,
            AssignInput {
                session_id: beta.clone(),
                owner_session_id: owner_b.clone(),
            },
        )
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("is failed and cannot own members"),
        "{refused}"
    );
    set_task_state(&store, "ses_owner_b", "running");
    store
        .submit(|tx| {
            let mut archived = row("ses_owner_b", Some("ses_master"));
            archived.time_archived = Some(9);
            tables::SessionTable::put(tx, &archived)
        })
        .unwrap()
        .wait()
        .unwrap();
    let refused = runtime
        .assign(
            &master,
            AssignInput {
                session_id: beta.clone(),
                owner_session_id: owner_b.clone(),
            },
        )
        .await
        .unwrap_err();
    assert!(
        refused
            .to_string()
            .contains("is archived and cannot own members"),
        "{refused}"
    );
    store
        .submit(|tx| tables::SessionTable::put(tx, &row("ses_owner_b", Some("ses_master"))))
        .unwrap()
        .wait()
        .unwrap();

    store
        .submit(|tx| {
            tables::PendingTable::insert(
                tx,
                &tables::Pending {
                    id: "msg_alpha_queued".into(),
                    session_id: "ses_alpha".into(),
                    type_: "synthetic".into(),
                    data: parse_json(r#"{"text":"queued"}"#).unwrap(),
                    delivery: Some("queue".into()),
                    admitted_seq: 0,
                    time_created: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let settled = member_event(
        &store,
        "evt_alpha_settled_queued",
        "ses_alpha",
        "session.execution.succeeded.1",
        session_data("ses_alpha"),
    );
    runtime.handle(&Payload::Durable(settled)).await.unwrap();
    assert_eq!(notices_with(&sessions, "ses_owner_a", "completed").len(), 0);
    store
        .submit(|tx| tx.delete::<tables::PendingTable>(&key("msg_alpha_queued")))
        .unwrap()
        .wait()
        .unwrap();
    let settled = member_event(
        &store,
        "evt_alpha_settled_drained",
        "ses_alpha",
        "session.execution.succeeded.1",
        session_data("ses_alpha"),
    );
    runtime
        .handle(&Payload::Durable(settled.clone()))
        .await
        .unwrap();
    runtime.handle(&Payload::Durable(settled)).await.unwrap();
    assert_eq!(notices_with(&sessions, "ses_owner_a", "completed").len(), 1);
    assert_eq!(notices_with(&sessions, "ses_master", "completed").len(), 0);

    for (id, kind) in [
        ("evt_beta_started", "session.execution.started.1"),
        ("evt_beta_progress", "session.step.ended.1"),
        ("evt_beta_settled", "session.execution.succeeded.1"),
    ] {
        let event = member_event(&store, id, "ses_beta", kind, session_data("ses_beta"));
        runtime.handle(&Payload::Durable(event)).await.unwrap();
    }
    assert_eq!(sessions.pending_list(&master).unwrap().len(), 0);
    assert_eq!(sessions.pending_list(&owner_b).unwrap().len(), 0);
    runtime
        .assign(
            &master,
            AssignInput {
                session_id: beta.clone(),
                owner_session_id: owner_b.clone(),
            },
        )
        .await
        .unwrap();
    let changed = owner_changed_event(&store, &group.id);
    runtime
        .handle(&Payload::Durable(changed.clone()))
        .await
        .unwrap();
    runtime.handle(&Payload::Durable(changed)).await.unwrap();
    let held = notices_with(&sessions, "ses_owner_b", "completed");
    assert_eq!(held.len(), 1, "held notices: {held:?}");
    let JsonValue::Object(fields) = &held[0] else {
        panic!("held metadata")
    };
    assert!(
        fields.get(&"held".into()).is_some(),
        "held metadata: {held:?}"
    );
    assert_eq!(
        notices_with(&sessions, "ses_owner_b", "permission").len(),
        1
    );
    assert_eq!(
        sessions.pending_list(&master).unwrap().len(),
        0,
        "master pending: {:?}",
        pending_metadata(&sessions, "ses_master")
    );

    set_task_state(&store, "ses_owner_b", "cancelled");
    let stale_notice = |id: &str, runtime: &Runtime| {
        let runtime = runtime.clone();
        let event = member_event(
            &store,
            id,
            "ses_beta",
            "session.execution.failed.1",
            failed_data("ses_beta", "late"),
        );
        async move { runtime.handle(&Payload::Durable(event)).await }
    };
    stale_notice("evt_beta_stale_failed", &runtime)
        .await
        .unwrap();
    assert!(
        runtime
            .get(&group.id)
            .await
            .unwrap()
            .members
            .iter()
            .find(|member| member.session_id == beta)
            .unwrap()
            .owner
            .is_none()
    );
    let master_notices = pending_metadata(&sessions, "ses_master");
    assert_eq!(
        master_notices
            .iter()
            .filter(|metadata| metadata_field(metadata, "source").as_deref()
                == Some("project_escalation"))
            .count(),
        2,
        "handoff + failed escalations: {master_notices:?}"
    );
    assert!(
        master_notices
            .iter()
            .all(|metadata| metadata_field(metadata, "reason").as_deref() == Some("owner-failed")),
        "{master_notices:?}"
    );
    let before = sessions.pending_list(&master).unwrap().len();
    stale_notice("evt_beta_stale_failed_repeat", &runtime)
        .await
        .unwrap();
    assert_eq!(
        sessions.pending_list(&master).unwrap().len(),
        before + 1,
        "a new failed event escalates once; the handed-off request is not re-delivered"
    );

    runtime
        .assign(
            &master,
            AssignInput {
                session_id: gamma.clone(),
                owner_session_id: owner_a.clone(),
            },
        )
        .await
        .unwrap();
    set_task_state(&store, "ses_owner_a", "completed");
    coordination
        .set_owner(
            &group.id,
            coordination::OwnerInput {
                session_id: gamma.clone(),
                owner_session_id: Some(owner_a.clone()),
                reason: None,
            },
        )
        .await
        .unwrap();
    runtime
        .handle(&Payload::Durable(owner_changed_event(&store, &group.id)))
        .await
        .unwrap();
    assert_eq!(task_state(&store, "ses_owner_a"), "supervising");
    let failed = member_event(
        &store,
        "evt_alpha_resume_owner",
        "ses_alpha",
        "session.execution.failed.1",
        failed_data("ses_alpha", "wake the owner"),
    );
    runtime.handle(&Payload::Durable(failed)).await.unwrap();
    assert_eq!(task_state(&store, "ses_owner_a"), "running");
    sessions
        .publish(tables::NewEvent {
            id: "evt_owner_a_settles_again".into(),
            aggregate_id: "ses_owner_a".into(),
            created: chrono::Utc::now().timestamp_millis(),
            type_: "session.task.updated.1".into(),
            data: parse_json(r#"{"sessionID":"ses_owner_a","change":{"type":"completed"}}"#)
                .unwrap(),
        })
        .await
        .unwrap();
    assert_eq!(task_state(&store, "ses_owner_a"), "supervising");
    for member in [alpha.clone(), gamma.clone()] {
        runtime
            .release(
                &master,
                ReleaseInput {
                    session_id: member,
                    reason: c::ReleaseReason::Released,
                },
            )
            .await
            .unwrap();
        runtime
            .handle(&Payload::Durable(owner_changed_event(&store, &group.id)))
            .await
            .unwrap();
    }
    assert_eq!(task_state(&store, "ses_owner_a"), "completed");
    let prefix = key("ses_owner_a");
    let completions = store
        .snapshot()
        .unwrap()
        .index_range::<tables::EventTable>(
            "event_aggregate_seq_idx",
            IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 64,
            },
        )
        .unwrap()
        .into_iter()
        .filter(|entry| {
            entry
                .record
                .id
                .as_str()
                .is_some_and(|id| id.starts_with("evt_task_ownership_completed_ses_owner_a_"))
        })
        .count();
    assert_eq!(completions, 1);
    runtime
        .handle(&Payload::Durable(owner_changed_event(&store, &group.id)))
        .await
        .unwrap();
    assert_eq!(task_state(&store, "ses_owner_a"), "completed");

    let ceiling =
        Document::new(rules(r#"[{"action":"bash","resource":"*","effect":"deny"}]"#).encode())
            .unwrap();
    store
        .submit(move |tx| {
            let mut master = tx.get::<tables::SessionTable>(&key("ses_master"))?.unwrap();
            master.permission = Some(ceiling);
            tables::SessionTable::put(tx, &master)
        })
        .unwrap()
        .wait()
        .unwrap();
    set_task_state(&store, "ses_owner_b", "running");
    let worktree = |name: ycoding_schema::LosslessString| {
        Box::pin(async move {
            let name = name.as_str().unwrap().to_owned();
            Ok(CreatedWorktree {
                directory: format!("/synthetic/{name}").as_str().into(),
                branch: name.as_str().into(),
            })
        }) as coordination::runtime::Future<'static, CreatedWorktree>
    };
    let created = Box::pin(runtime.create(
        &master,
        CreateInput {
            id: session::Id::new("ses_lane_one").unwrap(),
            agent_permissions: rules(r#"[{"action":"webfetch","resource":"*","effect":"deny"}]"#),
            target: coordination::runtime::CreateTarget::Worktree {
                name: "lane-one".into(),
                repository: None,
            },
            owner_session_id: Some(owner_b.clone()),
            title: Some("Owned lane".into()),
            prompt: Some("Implement the lane".into()),
            model: None,
        },
        Some(coordination::runtime::CreateProvider::Worktree(Box::new(
            worktree,
        ))),
    ))
    .await
    .unwrap();
    assert_eq!(
        created.branch.as_ref().and_then(|branch| branch.as_str()),
        Some("lane-one")
    );
    assert_eq!(created.directory.as_str(), Some("/synthetic/lane-one"));
    assert_eq!(created.owner.as_ref().unwrap().session_id, owner_b);
    assert!(matches!(created.prompt, Some(CreatePrompt::Sent(_))));
    let member = sessions.get(&created.session_id).unwrap().unwrap();
    assert_eq!(member.parent_id, None);
    assert_eq!(member.title.as_str(), Some("Owned lane"));
    assert_eq!(
        member.location.directory.as_lossless().as_str(),
        Some("/synthetic/lane-one")
    );
    assert_eq!(
        member.permission_ceiling.unwrap().encode(),
        parse_json(r#"[{"action":"bash","resource":"*","effect":"deny"},{"action":"webfetch","resource":"*","effect":"deny"}]"#).unwrap()
    );
    let member_pending = sessions.pending_list(&created.session_id).unwrap();
    assert_eq!(member_pending.len(), 1);
    assert_eq!(member_pending[0].type_.as_str(), Some("user"));
    assert!(
        coordination
            .get(&group.id)
            .unwrap()
            .member_session_ids
            .contains(&created.session_id)
    );

    let created_key = created.session_id.as_lossless().clone();
    store
        .submit(move |tx| {
            tx.delete::<tables::PendingTable>(&key(
                member_pending[0].id.as_str().unwrap(),
            ))?;
            tables::MessageTable::insert(
                tx,
                &tables::Message {
                    id: "msg_lane_errored".into(),
                    session_id: created_key,
                    type_: "assistant".into(),
                    seq: 1,
                    time_created: 2,
                    time_updated: 2,
                    data: parse_json(
                        r#"{"agent":"build","model":{"providerID":"local","id":"test"},"time":{"created":1,"completed":2},"content":[{"type":"text","text":"Partial lane text"}],"finish":"error","error":{"type":"provider.invalid-output","message":"Provider did not settle the step"}}"#,
                    )
                    .unwrap(),
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let settled = member_event(
        &store,
        "evt_lane_settled",
        created.session_id.as_lossless().as_str().unwrap(),
        "session.execution.succeeded.1",
        session_data(created.session_id.as_lossless().as_str().unwrap()),
    );
    runtime.handle(&Payload::Durable(settled)).await.unwrap();
    let completed = notices_with(&sessions, "ses_owner_b", "completed")
        .into_iter()
        .filter(|metadata| {
            metadata_field(metadata, "memberSessionID").as_deref()
                == created.session_id.as_lossless().as_str()
        })
        .collect::<Vec<_>>();
    assert_eq!(completed.len(), 1, "completed notices: {completed:?}");
    assert_eq!(
        metadata_field(&completed[0], "excerpt").as_deref(),
        Some("Provider did not settle the step")
    );

    let sessions_before = store
        .snapshot()
        .unwrap()
        .scan::<tables::SessionTable>(Bound::Unbounded, Bound::Unbounded, 512)
        .unwrap()
        .len();
    let refused = Box::pin(runtime.create(
        &master,
        CreateInput {
            id: session::Id::new("ses_lane_taken").unwrap(),
            agent_permissions: rules("[]"),
            target: coordination::runtime::CreateTarget::Worktree {
                name: "lane-taken".into(),
                repository: None,
            },
            owner_session_id: None,
            title: None,
            prompt: None,
            model: None,
        },
        Some(coordination::runtime::CreateProvider::Worktree(Box::new(
            |_| {
                Box::pin(async {
                    Err(coordination::Error::refused(
                        "A worktree named lane-taken already exists",
                    ))
                }) as coordination::runtime::Future<'static, CreatedWorktree>
            },
        ))),
    ))
    .await
    .unwrap_err();
    assert_eq!(
        refused.to_string(),
        "A worktree named lane-taken already exists"
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<tables::SessionTable>(Bound::Unbounded, Bound::Unbounded, 512)
            .unwrap()
            .len(),
        sessions_before
    );

    let client = store.client();
    let partial = Box::pin(runtime.create(
        &master,
        CreateInput {
            id: session::Id::new("ses_lane_partial").unwrap(),
            agent_permissions: rules("[]"),
            target: coordination::runtime::CreateTarget::Worktree {
                name: "lane-partial".into(),
                repository: None,
            },
            owner_session_id: Some(owner_b.clone()),
            title: None,
            prompt: None,
            model: None,
        },
        Some(coordination::runtime::CreateProvider::Worktree(Box::new(
            move |name| {
                Box::pin(async move {
                    client
                        .submit(|tx| {
                            let mut row =
                                tx.get::<tables::TaskTable>(&key("ses_owner_b"))?.unwrap();
                            row.state = "cancelled".into();
                            tables::TaskTable::put(tx, &row)
                        })?
                        .await?;
                    Ok(CreatedWorktree {
                        directory: format!("/synthetic/{}", name.as_str().unwrap())
                            .as_str()
                            .into(),
                        branch: name,
                    })
                }) as coordination::runtime::Future<'static, CreatedWorktree>
            },
        ))),
    ))
    .await
    .unwrap()
    .enrollment
    .error
    .unwrap()
    .to_utf8()
    .unwrap();
    assert!(
        partial.to_string().contains("/synthetic/lane-partial")
            && partial.to_string().contains("lane-partial")
            && partial.to_string().contains("nothing was removed"),
        "{partial}"
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<tables::SessionTable>(Bound::Unbounded, Bound::Unbounded, 512)
            .unwrap()
            .len(),
        sessions_before + 1,
        "the created Session is kept after a partial failure"
    );

    Box::pin(member_control_boundaries(
        &runtime,
        &sessions,
        &coordination,
        &store,
        &root,
        &group.id,
    ))
    .await;
    execution.shutdown().await.unwrap();
    let _ = wakes;
}

async fn member_control_boundaries(
    runtime: &Runtime,
    sessions: &SessionStore,
    coordination: &Service,
    store: &Store,
    root: &std::path::Path,
    group_id: &c::GroupId,
) {
    use ycoding_schema::{Nullable, model as model_schema};

    let master = sid("ses_master");
    let alpha = sid("ses_alpha");
    let canonical = root.join("canonical");
    std::fs::create_dir_all(&canonical).unwrap();
    let directory: ycoding_schema::LosslessString = canonical.to_str().unwrap().into();
    let saved_directory = directory.clone();
    store
        .submit(move |tx| {
            let mut project = tx.get::<project::ProjectTable>(&key("prj_u5"))?.unwrap();
            project.id = "prj_canonical".into();
            project.worktree = saved_directory;
            project.name = Some("Canonical fixture".into());
            project::ProjectTable::insert(tx, &project)
        })
        .unwrap()
        .await
        .unwrap();
    let input = CreateInput {
        id: sid("ses_canonical_member"),
        agent_permissions: rules("[]"),
        target: coordination::runtime::CreateTarget::Project {
            project_id: ycoding_schema::project::Id::new("prj_canonical").unwrap(),
        },
        owner_session_id: None,
        title: Some("Canonical member".into()),
        prompt: Some("Synthetic canonical work".into()),
        model: None,
    };
    let created = Box::pin(runtime.create(&master, input.clone(), None))
        .await
        .unwrap();
    assert_eq!(created.session_id, input.id);
    assert_eq!(created.directory, directory);
    assert!(created.branch.is_none());
    assert!(created.enrollment.member);
    assert!(matches!(created.prompt, Some(CreatePrompt::Sent(_))));
    Box::pin(runtime.interrupt(
        &master,
        coordination::runtime::InterruptInput {
            session_id: input.id.clone(),
        },
    ))
    .await
    .unwrap();
    let member = sessions.get(&input.id).unwrap().unwrap();
    assert!(member.parent_id.is_none());
    assert_eq!(member.project_id.as_lossless(), &"prj_canonical".into());
    assert_eq!(member.location.directory.as_lossless(), &directory);
    let before_count = store
        .snapshot()
        .unwrap()
        .scan::<tables::SessionTable>(Bound::Unbounded, Bound::Unbounded, 512)
        .unwrap()
        .len();
    let before_group = coordination.get(group_id).unwrap();
    let before_log = sessions.log(&input.id, None, 512).unwrap().events.len();
    let before_pending = sessions.pending_list(&input.id).unwrap();
    assert_eq!(before_pending.len(), 1);
    let replay = Box::pin(runtime.create(&master, input.clone(), None))
        .await
        .unwrap();
    assert_eq!(replay.session_id, input.id);
    assert_eq!(replay.location, member.location);
    assert_eq!(
        sessions.pending_list(&input.id).unwrap()[0].id,
        before_pending[0].id
    );
    assert_eq!(sessions.pending_list(&input.id).unwrap().len(), 1);
    assert_eq!(
        sessions.log(&input.id, None, 512).unwrap().events.len(),
        before_log
    );
    assert_eq!(
        coordination.get(group_id).unwrap().revision,
        before_group.revision
    );
    let mut conflicting = input.clone();
    conflicting.title = Some("Conflicting title".into());
    assert!(
        Box::pin(runtime.create(&master, conflicting, None))
            .await
            .unwrap_err()
            .to_string()
            .contains("different input")
    );
    assert_eq!(
        sessions.log(&input.id, None, 512).unwrap().events.len(),
        before_log
    );
    assert_eq!(sessions.pending_list(&input.id).unwrap().len(), 1);
    assert_eq!(
        coordination.get(group_id).unwrap().revision,
        before_group.revision
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<tables::SessionTable>(Bound::Unbounded, Bound::Unbounded, 512)
            .unwrap()
            .len(),
        before_count
    );

    let selected = model_schema::Ref::decode(
        &parse_json(
            r#"{"providerID":"openai","id":"gpt-reasoning","variant":"high","profile":"Work"}"#,
        )
        .unwrap(),
    )
    .unwrap();
    let selection = coordination::runtime::ModelInput {
        session_id: input.id.clone(),
        expected_model: Nullable::Null,
        model: selected.clone(),
    };
    let selected_member = Box::pin(runtime.set_model(&master, selection.clone()))
        .await
        .unwrap();
    assert_eq!(selected_member.model, Nullable::Value(selected.clone()));
    assert_eq!(
        sessions.get(&input.id).unwrap().unwrap().model,
        Some(selected.clone())
    );
    let binding = sessions.profile_binding(&input.id).unwrap().unwrap();
    assert_eq!(binding.provider_id, selected.provider_id);
    assert_eq!(binding.profile, selected.profile.clone().unwrap());
    let selected_events = sessions.log(&input.id, None, 512).unwrap().events.len();
    assert!(
        Box::pin(runtime.set_model(&master, selection))
            .await
            .unwrap_err()
            .to_string()
            .contains("expected model changed")
    );
    assert_eq!(
        sessions.log(&input.id, None, 512).unwrap().events.len(),
        selected_events
    );
    assert_eq!(sessions.profile_binding(&input.id).unwrap(), Some(binding));
    assert_eq!(
        sessions.get(&input.id).unwrap().unwrap().model,
        Some(selected)
    );

    for pending in [&alpha, &input.id] {
        assert!(
            Box::pin(runtime.remove(
                &master,
                coordination::runtime::MemberInput {
                    session_id: pending.clone(),
                },
                None,
            ))
            .await
            .unwrap_err()
            .to_string()
            .contains("active work or pending requests")
        );
    }
    assert!(
        sessions
            .promote_next_queued(&input.id, chrono::Utc::now().timestamp_millis())
            .await
            .unwrap()
    );
    assert!(sessions.pending_list(&input.id).unwrap().is_empty());
    let retained = sessions.get(&input.id).unwrap().unwrap();
    let removed = Box::pin(runtime.remove(
        &master,
        coordination::runtime::MemberInput {
            session_id: input.id.clone(),
        },
        None,
    ))
    .await
    .unwrap();
    assert!(removed.removed);
    assert_eq!(removed.session_id, input.id);
    assert!(
        !coordination
            .get(group_id)
            .unwrap()
            .member_session_ids
            .contains(&input.id)
    );
    let after = sessions.get(&input.id).unwrap().unwrap();
    assert_eq!(after.location, retained.location);
    assert_eq!(after.model, retained.model);
    assert!(
        Box::pin(runtime.member(
            &master,
            coordination::runtime::MemberInput {
                session_id: input.id,
            }
        ))
        .await
        .is_err()
    );
    Box::pin(directory_member_boundaries(
        runtime,
        sessions,
        coordination,
        store,
        root,
        group_id,
    ))
    .await;
    Box::pin(attach_member_boundaries(
        runtime,
        sessions,
        coordination,
        store,
        group_id,
    ))
    .await;
}

type Authorized = Arc<std::sync::Mutex<Vec<ycoding_schema::location::Ref>>>;

fn authorizer(
    seen: &Authorized,
    effect: impl FnOnce() -> Result<(), coordination::Error> + Send + 'static,
) -> coordination::runtime::AuthorizeLocation {
    let seen = seen.clone();
    Box::new(move |location| {
        Box::pin(async move {
            seen.lock().unwrap().push(location);
            effect()
        }) as coordination::runtime::Future<'static, ()>
    })
}

fn put_session(client: &ycoding_store::Client, session: tables::Session) {
    client
        .submit(move |tx| tables::SessionTable::put(tx, &session))
        .unwrap()
        .wait()
        .unwrap();
}

async fn attach_member_boundaries(
    runtime: &Runtime,
    sessions: &SessionStore,
    coordination: &Service,
    store: &Store,
    group_id: &c::GroupId,
) {
    use ycoding_core::coordination::runtime::{AttachInput, MemberInput};

    for id in [
        "ses_delta",
        "ses_standalone",
        "ses_archived",
        "ses_late",
        "ses_other_master",
        "ses_other_member",
    ] {
        let mut session = row(id, None);
        if id == "ses_standalone" {
            session.scope = "standalone".into();
        }
        if id == "ses_archived" {
            session.time_archived = Some(9);
        }
        put_session(store, session);
    }
    for (id, state) in [
        ("ses_owner_live", "running"),
        ("ses_owner_failed", "failed"),
    ] {
        put_session(store, row(id, Some("ses_master")));
        put_task(store, task(id, "ses_master", state));
    }
    coordination
        .create(c::CreateInput {
            name: "Other".into(),
            master_session_id: sid("ses_other_master"),
            member_session_ids: vec![sid("ses_other_member")],
        })
        .await
        .unwrap();
    let master = sid("ses_master");
    let root = sid("ses_root");
    let seen = Authorized::default();
    let attach = |caller: &str,
                  id: &str,
                  owner: Option<&str>,
                  authorize: coordination::runtime::AuthorizeLocation| {
        let caller = sid(caller);
        let input = AttachInput {
            session_id: sid(id),
            owner_session_id: owner.map(sid),
        };
        let runtime = runtime.clone();
        async move { Box::pin(runtime.attach(&caller, input, authorize, None)).await }
    };
    let members = || coordination.get(group_id).unwrap().member_session_ids;
    let initial = members();
    assert!(!initial.contains(&root));

    for caller in ["ses_owner_live", "ses_delta"] {
        let refused = attach(caller, "ses_root", None, authorizer(&seen, || Ok(())))
            .await
            .unwrap_err();
        assert!(
            refused
                .to_string()
                .contains("Only the Project's Master attaches Sessions"),
            "{caller}: {refused}"
        );
    }
    for (id, owner, reason) in [
        ("ses_master", None, "cannot attach itself"),
        ("ses_mid", None, "is a child Session, not a root"),
        ("ses_absent", None, "does not exist"),
        ("ses_archived", None, "is archived"),
        (
            "ses_standalone",
            None,
            "is a standalone Session and cannot join a Project",
        ),
        (
            "ses_root",
            Some("ses_owner_failed"),
            "is failed and cannot own members",
        ),
        (
            "ses_root",
            Some("ses_delta"),
            "is not a subagent the Master launched",
        ),
    ] {
        let refused = attach("ses_master", id, owner, authorizer(&seen, || Ok(())))
            .await
            .unwrap_err();
        assert!(refused.to_string().contains(reason), "{id}: {refused}");
    }
    assert!(seen.lock().unwrap().is_empty());
    assert_eq!(members(), initial);

    let other = attach(
        "ses_master",
        "ses_other_member",
        None,
        authorizer(&seen, || Ok(())),
    )
    .await
    .unwrap_err();
    assert!(
        other
            .to_string()
            .contains("already belongs to another Project"),
        "{other}"
    );
    let denied = attach(
        "ses_master",
        "ses_root",
        None,
        authorizer(&seen, || {
            Err(coordination::Error::refused("external_directory denied"))
        }),
    )
    .await
    .unwrap_err();
    assert!(
        denied.to_string().contains("external_directory denied"),
        "{denied}"
    );
    assert_eq!(members(), initial);
    seen.lock().unwrap().clear();

    let before = sessions.get(&root).unwrap().unwrap();
    let attached = attach("ses_master", "ses_root", None, authorizer(&seen, || Ok(())))
        .await
        .unwrap();
    assert_eq!(&attached.group_id, group_id);
    assert_eq!(attached.session_id, root);
    assert_eq!(attached.owner_session_id, master);
    assert_eq!(attached.location, before.location);
    assert!(!attached.reconciled);
    assert_eq!(*seen.lock().unwrap(), vec![before.location.clone()]);
    assert!(members().contains(&root));
    let after = sessions.get(&root).unwrap().unwrap();
    assert_eq!(
        (after.location, after.model, after.title, after.parent_id),
        (before.location.clone(), before.model, before.title, None)
    );
    assert_eq!(
        sessions.get(&sid("ses_mid")).unwrap().unwrap().parent_id,
        Some(root.clone())
    );
    let owner = Box::pin(runtime.member(
        &master,
        MemberInput {
            session_id: root.clone(),
        },
    ))
    .await
    .unwrap()
    .owner
    .map(|owner| owner.session_id);
    assert_eq!(owner, Some(master.clone()));

    let revision = coordination.get(group_id).unwrap().revision;
    let again = attach("ses_master", "ses_root", None, authorizer(&seen, || Ok(())))
        .await
        .unwrap();
    assert!(again.reconciled);
    assert_eq!(again.owner_session_id, master);
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(coordination.get(group_id).unwrap().revision, revision);
    let different = attach(
        "ses_master",
        "ses_root",
        Some("ses_owner_live"),
        authorizer(&seen, || Ok(())),
    )
    .await
    .unwrap_err();
    assert!(
        different
            .to_string()
            .contains("use assign to change its owner"),
        "{different}"
    );

    let owned = attach(
        "ses_master",
        "ses_delta",
        Some("ses_owner_live"),
        authorizer(&seen, || Ok(())),
    )
    .await
    .unwrap();
    assert_eq!(owned.owner_session_id, sid("ses_owner_live"));
    assert!(!owned.reconciled);

    let archiving = store.client().clone();
    let late = attach(
        "ses_master",
        "ses_late",
        None,
        authorizer(&seen, move || {
            let mut session = row("ses_late", None);
            session.time_archived = Some(10);
            put_session(&archiving, session);
            Ok(())
        }),
    )
    .await
    .unwrap_err();
    assert!(late.to_string().contains("is archived"), "{late}");
    assert!(!members().contains(&sid("ses_late")));
    assert_eq!(seen.lock().unwrap().len(), 3);
}

type Opened = Arc<std::sync::Mutex<Vec<(String, bool)>>>;

fn chosen(home: &std::path::Path, opened: &Opened) -> coordination::runtime::CreateProvider {
    let opened = opened.clone();
    coordination::runtime::CreateProvider::Directory(coordination::runtime::CreateDirectory {
        home: home.to_path_buf(),
        open: Box::new(move |directory, missing| {
            Box::pin(async move {
                let path = directory.as_lossless().to_utf8().unwrap();
                if missing {
                    std::fs::create_dir_all(&path).unwrap();
                }
                opened.lock().unwrap().push((path, missing));
                Ok(ycoding_schema::project::Id::new("prj_u5").unwrap())
            }) as coordination::runtime::Future<'static, ycoding_schema::project::Id>
        }),
    })
}

fn directory_input(id: &str, target: coordination::runtime::CreateTarget) -> CreateInput {
    CreateInput {
        id: sid(id),
        agent_permissions: rules("[]"),
        target,
        owner_session_id: None,
        title: None,
        prompt: None,
        model: None,
    }
}

async fn directory_member_boundaries(
    runtime: &Runtime,
    sessions: &SessionStore,
    coordination: &Service,
    store: &Store,
    root: &std::path::Path,
    group_id: &c::GroupId,
) {
    let master = sid("ses_master");
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let opened = Opened::default();
    let members = coordination.get(group_id).unwrap().member_session_ids;
    let count = || {
        store
            .snapshot()
            .unwrap()
            .scan::<tables::SessionTable>(Bound::Unbounded, Bound::Unbounded, 512)
            .unwrap()
            .len()
    };
    let before = count();

    let global = Box::pin(runtime.create(
        &master,
        directory_input(
            "ses_global_member",
            coordination::runtime::CreateTarget::Project {
                project_id: ycoding_schema::project::Id::new("global").unwrap(),
            },
        ),
        None,
    ))
    .await
    .unwrap_err();
    assert!(global.to_string().contains("pass directory"), "{global}");

    let file = root.join("existing-file");
    std::fs::write(&file, "untouched").unwrap();
    for (id, directory, reason) in [
        (
            "ses_relative_member",
            "relative/path".to_owned(),
            "absolute",
        ),
        (
            "ses_named_home_member",
            "~other/path".to_owned(),
            "absolute",
        ),
        (
            "ses_file_member",
            file.to_str().unwrap().to_owned(),
            "not a directory",
        ),
        (
            "ses_file_child_member",
            file.join("child").to_str().unwrap().to_owned(),
            "not a directory",
        ),
    ] {
        let refused = Box::pin(runtime.create(
            &master,
            directory_input(
                id,
                coordination::runtime::CreateTarget::Directory {
                    directory: directory.as_str().into(),
                },
            ),
            Some(chosen(&home, &opened)),
        ))
        .await
        .unwrap_err();
        assert!(
            refused.to_string().contains(reason),
            "{directory}: {refused}"
        );
        assert!(sessions.get(&sid(id)).unwrap().is_none());
    }
    let unprovided = Box::pin(runtime.create(
        &master,
        directory_input(
            "ses_unprovided_member",
            coordination::runtime::CreateTarget::Directory {
                directory: "/synthetic/unprovided".into(),
            },
        ),
        None,
    ))
    .await
    .unwrap_err();
    assert!(
        unprovided.to_string().contains("directory provider"),
        "{unprovided}"
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "untouched");
    assert!(opened.lock().unwrap().is_empty());
    assert_eq!(count(), before);
    assert_eq!(
        coordination.get(group_id).unwrap().member_session_ids,
        members
    );

    let expected = home.join("chosen folder").join("member");
    let input = directory_input(
        "ses_directory_member",
        coordination::runtime::CreateTarget::Directory {
            directory: "~/chosen folder/./member/".into(),
        },
    );
    let created = Box::pin(runtime.create(&master, input.clone(), Some(chosen(&home, &opened))))
        .await
        .unwrap();
    assert_eq!(created.directory.as_str(), expected.to_str());
    assert!(created.branch.is_none());
    assert!(created.enrollment.member);
    assert!(expected.is_dir());
    let member = sessions.get(&input.id).unwrap().unwrap();
    assert!(member.parent_id.is_none());
    assert_eq!(member.project_id.as_lossless().as_str(), Some("prj_u5"));
    assert_eq!(member.title.as_str(), Some("member"));
    assert_eq!(
        member.location.directory.as_lossless().as_str(),
        expected.to_str()
    );
    let replay = Box::pin(runtime.create(&master, input.clone(), Some(chosen(&home, &opened))))
        .await
        .unwrap();
    assert_eq!(replay.session_id, input.id);
    assert_eq!(count(), before + 1);
    assert_eq!(
        *opened.lock().unwrap(),
        vec![
            (expected.to_str().unwrap().to_owned(), true),
            (expected.to_str().unwrap().to_owned(), false),
        ]
    );
    let moved_home = root.join("other-home");
    let moved = Box::pin(runtime.create(&master, input, Some(chosen(&moved_home, &opened))))
        .await
        .unwrap_err();
    assert!(
        moved
            .to_string()
            .contains("directory changed after creation was recorded"),
        "{moved}"
    );
    assert!(!moved_home.exists());
    assert_eq!(opened.lock().unwrap().len(), 2);

    let root_member = Box::pin(runtime.create(
        &master,
        directory_input(
            "ses_root_member",
            coordination::runtime::CreateTarget::Directory {
                directory: "/".into(),
            },
        ),
        Some(chosen(&home, &opened)),
    ))
    .await
    .unwrap();
    assert_eq!(
        sessions
            .get(&root_member.session_id)
            .unwrap()
            .unwrap()
            .title
            .as_str(),
        Some("/")
    );
}
