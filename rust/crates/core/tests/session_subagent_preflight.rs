use std::sync::Arc;
use ycoding_core::{
    resources::{
        agent,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        orchestration::{
            Error, Execution, LaunchInput, Preflight, PreflightRequest, Prepared, Service,
            ToolCall, authorize,
        },
        run_coordinator::{Outcome, RunFuture},
        store,
    },
};
use ycoding_schema::{DomainDecode, DomainEncode, parse_json, permission, session};
use ycoding_store::{
    KeyPart, Store,
    session::{Document, SessionTable},
    tuple_key,
};

#[path = "autonomy_support/mod.rs"]
mod support;

mod policy {
    include!("policy_fixture.rs");
}

#[path = "session_support/guardrails.rs"]
mod guardrails;

struct Quiet;

impl Execution for Quiet {
    fn resume(&self, _: &session::Id) -> RunFuture {
        panic!("unexpected explicit resumption")
    }

    fn wake(&self, _: &session::Id) -> Outcome {
        Ok(())
    }
    fn interrupt(&self, _: &session::Id) -> RunFuture {
        Box::pin(async { Ok(()) })
    }
}

fn model_ref(json: &str) -> ycoding_schema::model::Ref {
    ycoding_schema::model::Ref::decode(&parse_json(json).unwrap()).unwrap()
}

fn agent_info(
    id: &str,
    mode: &str,
    model: Option<&str>,
    denied: &[&str],
) -> ycoding_schema::agent::Info {
    let mut info = agent::empty(id.into());
    info.mode = mode.into();
    info.model = model.map(model_ref);
    info.permissions = denied
        .iter()
        .map(|action| permission::Rule {
            action: (*action).into(),
            resource: "*".into(),
            effect: permission::Effect("deny".into()),
        })
        .collect();
    info
}

fn catalog() -> Catalog {
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
            r#"{"model":{"providerID":"openai","model":"gpt-reasoning"},"providers":{"openai":{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"apiKey":"fixture","baseURL":"http://127.0.0.1:1"}},"anthropic":{"package":"@ai-sdk/anthropic","settings":{"apiKey":"fixture","baseURL":"http://127.0.0.1:1"}}}}"#,
        )
        .unwrap()])
        .unwrap();
    catalog
}

struct Fixture {
    store: Store,
    sessions: store::Service,
    credentials: credential::Service,
    preflight: Preflight,
    resolver: Arc<model::Resolver>,
}

fn fixture() -> Fixture {
    let store = support::store();
    let parent_model = Document::from_domain(&model_ref(
        r#"{"providerID":"openai","id":"gpt-reasoning"}"#,
    ))
    .unwrap();
    store
        .submit(move |tx| {
            let key = tuple_key(&[KeyPart::String(&"ses_one".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.agent = Some("build".into());
            row.model = Some(parent_model);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let sessions = store::Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    let agents = agent::Service::new(vec![
        agent_info("build", "primary", None, &["bash"]),
        agent_info("explore", "subagent", None, &[]),
        agent_info("open", "all", None, &[]),
        agent_info(
            "deep",
            "subagent",
            Some(r#"{"providerID":"anthropic","id":"claude-budget"}"#),
            &[],
        ),
        agent_info(
            "broken",
            "subagent",
            Some(r#"{"providerID":"openai","id":"missing-model"}"#),
            &[],
        ),
        agent_info(
            "profiled",
            "subagent",
            Some(r#"{"providerID":"openai","id":"gpt-reasoning","profile":"Work"}"#),
            &[],
        ),
    ]);
    let resolver = Arc::new(model::Resolver::new(catalog()));
    Fixture {
        preflight: Preflight::new(
            sessions.clone(),
            ycoding_core::resources::domain_state::DomainState::new(agents),
            resolver.clone(),
            credentials.clone(),
        ),
        store,
        sessions,
        credentials,
        resolver,
    }
}

fn request(agent: &str, model: Option<&str>, caller: Option<&str>) -> PreflightRequest {
    PreflightRequest {
        agent: agent.into(),
        model: model.map(model_ref),
        caller: caller.map(Into::into),
    }
}

fn parent() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn message(error: Error) -> String {
    match error {
        Error::InvalidRequest(text) => text,
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn unknown_primary_and_callerless_requests_are_rejected_before_any_child_exists() {
    let fixture = fixture();
    let prepare = |request: PreflightRequest| fixture.preflight.prepare(&parent(), &request);
    assert_eq!(
        message(prepare(request("ghost", None, None)).err().unwrap()),
        "Unknown agent: ghost"
    );
    assert_eq!(
        message(prepare(request("build", None, None)).err().unwrap()),
        "Agent build cannot run as a subagent"
    );
    assert_eq!(
        message(
            prepare(request("explore", None, Some("ghost")))
                .err()
                .unwrap()
        ),
        "Parent agent is unavailable"
    );
    assert!(matches!(
        fixture.preflight.prepare(
            &session::Id::new("ses_missing").unwrap(),
            &request("explore", None, None)
        ),
        Err(Error::SessionNotFound(_))
    ));
    let open = prepare(request("open", None, None)).unwrap();
    assert_eq!(open.agent.as_str(), Some("open"));
}

#[test]
fn the_callers_denials_feed_the_child_ceiling_input() {
    let fixture = fixture();
    let by_parent = fixture
        .preflight
        .prepare(&parent(), &request("explore", None, None))
        .unwrap();
    assert_eq!(
        by_parent.caller_permissions.encode(),
        parse_json(r#"[{"action":"bash","resource":"*","effect":"deny"}]"#).unwrap()
    );
    let by_caller = fixture
        .preflight
        .prepare(&parent(), &request("explore", None, Some("open")))
        .unwrap();
    assert_ne!(by_caller.caller_permissions, by_parent.caller_permissions);
}

#[test]
fn spawn_model_beats_agent_model_beats_parent_model() {
    let fixture = fixture();
    let provider = |prepared: Prepared| prepared.model.provider_id.0.to_utf8().unwrap();
    let prepare = |agent: &str, spawn: Option<&str>| {
        fixture
            .preflight
            .prepare(&parent(), &request(agent, spawn, None))
    };
    assert_eq!(provider(prepare("explore", None).unwrap()), "openai");
    assert_eq!(provider(prepare("deep", None).unwrap()), "anthropic");
    assert_eq!(
        provider(
            prepare(
                "deep",
                Some(r#"{"providerID":"openai","id":"gpt-reasoning"}"#)
            )
            .unwrap()
        ),
        "openai"
    );
    let unavailable = message(prepare("broken", None).err().unwrap());
    assert!(unavailable.contains("Model unavailable"), "{unavailable}");
    assert_eq!(
        provider(
            prepare(
                "broken",
                Some(r#"{"providerID":"anthropic","id":"claude-budget"}"#)
            )
            .unwrap()
        ),
        "anthropic"
    );
    let missing_spawn = message(
        prepare("explore", Some(r#"{"providerID":"openai","id":"nope"}"#))
            .err()
            .unwrap(),
    );
    assert!(
        missing_spawn.contains("Model unavailable"),
        "{missing_spawn}"
    );
}

fn secret(value: &str) -> ycoding_store::resources::Secret {
    ycoding_store::resources::Secret::new(
        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: value.into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

#[tokio::test]
async fn profile_models_bind_the_child_session_and_stale_parent_bindings_need_an_explicit_rebind() {
    let fixture = fixture();
    let missing = message(
        fixture
            .preflight
            .prepare(&parent(), &request("profiled", None, None))
            .err()
            .unwrap(),
    );
    assert_eq!(
        missing,
        "Selected profile is unavailable; select the profile again"
    );

    fixture
        .credentials
        .create(
            "cred_work".into(),
            "openai".into(),
            Some("Work".into()),
            secret("one"),
            1,
        )
        .await
        .unwrap();
    let prepared = fixture
        .preflight
        .prepare(&parent(), &request("profiled", None, None))
        .unwrap();
    let binding = prepared.profile_binding.clone().unwrap();
    let generation = binding.account_generation.get();
    assert_eq!(binding.profile.0.as_str(), Some("Work"));
    assert_eq!(binding.credential_id.0.as_str(), Some("cred_work"));
    assert!(
        fixture
            .preflight
            .prepare(&parent(), &request("explore", None, None))
            .unwrap()
            .profile_binding
            .is_none()
    );

    let execution: Arc<dyn Execution> = Arc::new(Quiet);
    let service = Service::new(fixture.sessions.clone(), execution);
    let child = service
        .launch(LaunchInput {
            parent_id: parent(),
            parent_assistant_message_id: ycoding_schema::session_message::Id::new("msg_parent")
                .unwrap(),
            tool_call_id: "call_profile".into(),
            description: "Profiled".into(),
            prompt: "Work".into(),
            depth_limit: 1,
            prepared,
            guardrails: guardrails::guardrails(&fixture.store),
        })
        .await
        .unwrap();
    assert_eq!(
        fixture.sessions.profile_binding(&child.session_id).unwrap(),
        Some(binding)
    );

    let parent_profile = Document::from_domain(&model_ref(
        r#"{"providerID":"openai","id":"gpt-reasoning","profile":"Work"}"#,
    ))
    .unwrap();
    fixture
        .store
        .submit(move |tx| {
            let key = tuple_key(&[KeyPart::String(&"ses_one".into())]);
            let mut row = tx.get::<SessionTable>(&key)?.unwrap();
            row.model = Some(parent_profile);
            SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let (_, saved) = fixture
        .credentials
        .resolve_session(&"ses_one".into(), &"openai".into(), false)
        .unwrap()
        .unwrap();
    fixture
        .credentials
        .publish_binding(
            "ses_one".into(),
            "evt_parent_binding".into(),
            Some(saved),
            2,
        )
        .await
        .unwrap();
    let inherited = fixture
        .preflight
        .prepare(&parent(), &request("explore", None, None))
        .unwrap();
    assert!(inherited.profile_binding.is_some());

    fixture
        .credentials
        .update("cred_work".into(), None, Some(secret("two")), 3)
        .await
        .unwrap();
    let stale = message(
        fixture
            .preflight
            .prepare(&parent(), &request("explore", None, None))
            .err()
            .unwrap(),
    );
    assert_eq!(
        stale,
        "Selected profile is unavailable; select the profile again"
    );
    let rebound = fixture
        .preflight
        .prepare(&parent(), &request("profiled", None, None))
        .unwrap();
    assert_eq!(
        rebound.profile_binding.unwrap().account_generation.get(),
        generation + 1
    );
}

#[tokio::test]
async fn subagent_launch_permission_follows_the_callers_rules() {
    let fixture = policy::Fixture::default();
    let session = fixture.session("ses_root", None, 0, false, None);
    let call = ToolCall {
        agent: "test".into(),
        message_id: "msg_call".into(),
        call_id: "call_1".into(),
    };
    let target: ycoding_schema::agent::Id = "explore".into();
    let permissions = fixture.permissions();
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "subagent".into(),
        resource: "explore".into(),
        effect: permission::Effect("allow".into()),
    });
    authorize(&permissions, &session, &target, &call)
        .await
        .unwrap();
    fixture.rules.lock().unwrap().push(permission::Rule {
        action: "subagent".into(),
        resource: "explore".into(),
        effect: permission::Effect("deny".into()),
    });
    let denied = message(
        authorize(&permissions, &session, &target, &call)
            .await
            .err()
            .unwrap(),
    );
    assert!(denied.starts_with("Subagent denied: explore"), "{denied}");
    permissions.shutdown();
}

mod switch {
    use super::*;
    use std::sync::Mutex;
    use ycoding_core::{
        resources::attachment_store,
        session::{
            compaction_policy,
            orchestration::{ModelSwitch, SwitchModel},
            step_boundary,
        },
    };
    use ycoding_schema::{JsonValue, session_orchestration::State};
    use ycoding_store::session::{Message, MessageTable, TaskTable};

    #[derive(Default)]
    struct Counting {
        woken: Mutex<Vec<String>>,
        interrupted: Mutex<Vec<String>>,
    }

    impl Execution for Counting {
        fn resume(&self, _: &session::Id) -> RunFuture {
            Box::pin(async { Ok(()) })
        }
        fn wake(&self, id: &session::Id) -> Outcome {
            self.woken
                .lock()
                .unwrap()
                .push(id.as_lossless().as_str().unwrap().into());
            Ok(())
        }
        fn interrupt(&self, id: &session::Id) -> RunFuture {
            self.interrupted
                .lock()
                .unwrap()
                .push(id.as_lossless().as_str().unwrap().into());
            Box::pin(async { Ok(()) })
        }
    }

    pub(super) struct Child {
        pub(super) fixture: Fixture,
        pub(super) service: Service,
        execution: Arc<Counting>,
        pub(super) child: session::Id,
        pub(super) resolver: ModelSwitch,
    }

    pub(super) fn resolver(fixture: &Fixture, margin: i64) -> ModelSwitch {
        let compaction = compaction_policy::Resolved {
            context_safety_margin_tokens: margin,
            ..Default::default()
        };
        ModelSwitch::new(
            fixture.sessions.clone(),
            fixture.resolver.clone(),
            fixture.credentials.clone(),
            compaction,
            Arc::new(
                attachment_store::Store::new(
                    std::env::temp_dir()
                        .join(format!("ycoding-switch-attachments-{}", std::process::id())),
                )
                .unwrap(),
            ),
        )
    }

    pub(super) async fn child(margin: i64) -> Child {
        let fixture = fixture();
        let prepared = fixture
            .preflight
            .prepare(&parent(), &request("explore", None, None))
            .unwrap();
        let execution = Arc::new(Counting::default());
        let service = Service::new(fixture.sessions.clone(), execution.clone());
        let task = service
            .launch(LaunchInput {
                parent_id: parent(),
                parent_assistant_message_id: ycoding_schema::session_message::Id::new("msg_parent")
                    .unwrap(),
                tool_call_id: "call_switch".into(),
                description: "Selection fixture".into(),
                prompt: "Work".into(),
                depth_limit: 1,
                prepared,
                guardrails: guardrails::guardrails(&fixture.store),
            })
            .await
            .unwrap();
        let resolver = resolver(&fixture, margin);
        Child {
            fixture,
            service,
            execution,
            child: task.session_id,
            resolver,
        }
    }

    pub(super) fn old() -> ycoding_schema::model::Ref {
        model_ref(r#"{"providerID":"openai","id":"gpt-reasoning"}"#)
    }

    pub(super) fn target() -> ycoding_schema::model::Ref {
        model_ref(r#"{"providerID":"anthropic","id":"claude-budget"}"#)
    }

    impl Child {
        pub(super) fn input<'a>(
            &'a self,
            expected: &'a ycoding_schema::model::Ref,
            model: &'a ycoding_schema::model::Ref,
        ) -> SwitchModel<'a> {
            SwitchModel {
                parent_id: parent_ref(),
                child_id: &self.child,
                expected_model: expected,
                model,
                resolver: &self.resolver,
                authorize: None,
                permitted: None,
            }
        }
        pub(super) fn selected(&self) -> ycoding_schema::model::Ref {
            self.fixture
                .sessions
                .get(&self.child)
                .unwrap()
                .unwrap()
                .model
                .unwrap()
        }
    }

    fn parent_ref() -> &'static session::Id {
        static PARENT: std::sync::OnceLock<session::Id> = std::sync::OnceLock::new();
        PARENT.get_or_init(parent)
    }

    #[tokio::test]
    async fn idle_child_selection_preserves_task_state_launch_identity_and_authoritative_reads() {
        let f = child(4_096).await;
        let before = f.service.get(&parent(), &f.child).unwrap();
        let woken = f.execution.woken.lock().unwrap().len();
        let selected = f
            .service
            .switch_model(f.input(&old(), &target()))
            .await
            .unwrap();
        assert_eq!(selected.model, target());
        assert_eq!(selected.state, before.state);
        assert_eq!(f.selected(), target());
        assert_eq!(f.service.list(&parent()).unwrap()[0].model, target());
        assert_eq!(
            f.service.page(&parent(), None, None).unwrap().data[0].model,
            target()
        );
        let view = f.service.team_view(&parent()).unwrap().view;
        let JsonValue::Object(view) = &view else {
            panic!()
        };
        let Some(JsonValue::Array(children)) = view.get(&"children".into()) else {
            panic!()
        };
        let JsonValue::Object(first) = &children[0] else {
            panic!()
        };
        assert_eq!(first.get(&"model".into()).unwrap(), &target().encode());
        let row = f
            .fixture
            .store
            .snapshot()
            .unwrap()
            .get::<TaskTable>(&tuple_key(&[KeyPart::String(f.child.as_lossless())]))
            .unwrap()
            .unwrap();
        assert_eq!(row.model.value(), &old().encode());
        assert_eq!(f.execution.woken.lock().unwrap().len(), woken);
        assert!(f.execution.interrupted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn ownership_cas_and_invalid_targets_fail_without_changing_selection() {
        let f = child(4_096).await;
        for child_id in [
            parent(),
            session::Id::new("ses_two").unwrap(),
            session::Id::new("ses_missing").unwrap(),
        ] {
            let (expected, model) = (old(), target());
            let mut input = f.input(&expected, &model);
            input.child_id = &child_id;
            assert!(f.service.switch_model(input).await.is_err());
        }
        for model in [
            model_ref(r#"{"providerID":"anthropic","id":"missing"}"#),
            model_ref(r#"{"providerID":"anthropic","id":"claude-budget","variant":"missing"}"#),
            model_ref(r#"{"providerID":"anthropic","id":"claude-budget","profile":"Missing"}"#),
        ] {
            assert!(
                f.service
                    .switch_model(f.input(&old(), &model))
                    .await
                    .is_err()
            );
            assert_eq!(f.selected(), old());
        }
        let profiled =
            model_ref(r#"{"providerID":"anthropic","id":"claude-budget","profile":"Missing"}"#);
        assert!(matches!(
            f.service.switch_model(f.input(&old(), &profiled)).await,
            Err(Error::ProfileUnavailable { .. })
        ));
        f.service
            .switch_model(f.input(&old(), &target()))
            .await
            .unwrap();
        assert!(matches!(
            f.service.switch_model(f.input(&old(), &old())).await,
            Err(Error::Conflict(message)) if message == "The child or expected model changed before selection; read the child and retry"
        ));
        assert_eq!(f.selected(), target());
    }

    #[tokio::test]
    async fn known_selection_failures_carry_diagnostic_messages() {
        let f = child(4_096).await;
        let missing_id = session::Id::new("ses_missing").unwrap();
        let (expected, model) = (old(), target());
        let mut input = f.input(&expected, &model);
        input.child_id = &missing_id;
        let missing = f.service.switch_model(input).await.unwrap_err();
        assert!(matches!(missing, Error::NotFound { .. }));
        assert!(missing.to_string().contains("ses_missing"), "{missing}");
        let foreign_id = session::Id::new("ses_two").unwrap();
        let (expected, model) = (old(), target());
        let mut input = f.input(&expected, &model);
        input.child_id = &foreign_id;
        let forbidden = f.service.switch_model(input).await.unwrap_err();
        assert!(matches!(forbidden, Error::Forbidden { .. }));
        assert!(forbidden.to_string().contains("ses_two"), "{forbidden}");
    }

    #[tokio::test]
    async fn nonpositive_target_budget_is_a_compaction_conflict_without_writing() {
        let f = child(128_000).await;
        assert!(matches!(
            f.service.switch_model(f.input(&old(), &target())).await,
            Err(Error::CompactionConflict(_))
        ));
        assert_eq!(f.selected(), old());
    }

    #[tokio::test]
    async fn context_fit_refusal_reports_blocked_and_leaves_selection_unchanged() {
        let f = child(127_000).await;
        let big = "large retained history ".repeat(1000);
        let child_key = f.child.as_lossless().clone();
        f.fixture
            .store
            .submit(move |tx| {
                MessageTable::insert(
                    tx,
                    &Message {
                        id: "msg_switch_user".into(),
                        session_id: child_key.clone(),
                        type_: "user".into(),
                        seq: 10,
                        time_created: 10,
                        time_updated: 10,
                        data: parse_json(&format!(
                            r#"{{"text":{},"time":{{"created":10,"consumed":10}}}}"#,
                            ycoding_schema::stringify_json(&JsonValue::String(big.as_str().into()))
                        ))
                        .unwrap(),
                    },
                )
            })
            .unwrap()
            .wait()
            .unwrap();
        let blocked = f
            .service
            .switch_model(f.input(&old(), &target()))
            .await
            .unwrap_err();
        assert!(blocked.to_string().contains("context"), "{blocked}");
        let Error::ModelBlocked(blocked) = blocked else {
            panic!("expected blocked, got {blocked:?}");
        };
        assert_eq!(blocked.current_model, old());
        assert_eq!(blocked.target_model, target());
        assert_eq!(blocked.target_safe_input_tokens.get(), 1_000);
        assert_eq!(
            blocked.required_reduction_tokens.get(),
            blocked.current_context_tokens.get() - 1_000
        );
        assert_eq!(f.selected(), old());
    }

    #[tokio::test]
    async fn cancelling_archived_and_foreign_claimed_children_reject_without_writing() {
        let f = child(4_096).await;
        f.fixture
            .sessions
            .publish(ycoding_store::session::NewEvent {
                id: "evt_switch_cancel".into(),
                aggregate_id: f.child.as_lossless().clone(),
                created: 99,
                type_: "session.task.updated.1".into(),
                data: parse_json(&format!(
                    r#"{{"sessionID":"{}","change":{{"type":"cancel_requested"}}}}"#,
                    f.child.as_lossless().as_str().unwrap()
                ))
                .unwrap(),
            })
            .await
            .unwrap();
        assert!(matches!(
            f.service.switch_model(f.input(&old(), &target())).await,
            Err(Error::Conflict(message)) if message == "Wait for the child's lifecycle transition before selecting a model"
        ));
        f.fixture
            .sessions
            .publish(ycoding_store::session::NewEvent {
                id: "evt_switch_cancelled".into(),
                aggregate_id: f.child.as_lossless().clone(),
                created: 100,
                type_: "session.task.updated.1".into(),
                data: parse_json(&format!(
                    r#"{{"sessionID":"{}","change":{{"type":"cancelled"}}}}"#,
                    f.child.as_lossless().as_str().unwrap()
                ))
                .unwrap(),
            })
            .await
            .unwrap();
        let key = tuple_key(&[KeyPart::String(f.child.as_lossless())]);
        f.fixture
            .store
            .submit({
                let key = key.clone();
                move |tx| {
                    let mut row = tx.get::<SessionTable>(&key)?.unwrap();
                    row.time_archived = Some(1);
                    SessionTable::put(tx, &row)
                }
            })
            .unwrap()
            .wait()
            .unwrap();
        assert!(matches!(
            f.service.switch_model(f.input(&old(), &target())).await,
            Err(Error::Conflict(message)) if message == "Archived Sessions cannot change a child model"
        ));
        f.fixture
            .store
            .submit(move |tx| {
                let mut row = tx.get::<SessionTable>(&key)?.unwrap();
                row.time_archived = None;
                SessionTable::put(tx, &row)
            })
            .unwrap()
            .wait()
            .unwrap();
        let task_key = tuple_key(&[KeyPart::String(f.child.as_lossless())]);
        f.fixture
            .store
            .submit(move |tx| {
                let mut row = tx.get::<TaskTable>(&task_key)?.unwrap();
                row.owner_pid = Some(i64::from(std::process::id()) + 1);
                row.owner_started = Some("foreign".into());
                TaskTable::put(tx, &row)
            })
            .unwrap()
            .wait()
            .unwrap();
        assert!(matches!(
            f.service.switch_model(f.input(&old(), &target())).await,
            Err(Error::Conflict(message)) if message == "The child is owned by another runtime process"
        ));
        assert_eq!(f.selected(), old());
    }

    #[tokio::test]
    async fn waiting_and_terminal_children_keep_their_lifecycle_and_question() {
        for change in [
            r#"{"type":"question_asked","question":{"id":"qst_selection","text":"Continue?","time":1}}"#,
            r#"{"type":"completed"}"#,
        ] {
            let f = child(4_096).await;
            f.fixture
                .sessions
                .publish(ycoding_store::session::NewEvent {
                    id: format!("evt_switch_{}", f.child.as_lossless().as_str().unwrap()).into(),
                    aggregate_id: f.child.as_lossless().clone(),
                    created: 99,
                    type_: "session.task.updated.1".into(),
                    data: parse_json(&format!(
                        r#"{{"sessionID":"{}","change":{change}}}"#,
                        f.child.as_lossless().as_str().unwrap()
                    ))
                    .unwrap(),
                })
                .await
                .unwrap();
            let before = f.service.get(&parent(), &f.child).unwrap();
            let selected = f
                .service
                .switch_model(f.input(&old(), &target()))
                .await
                .unwrap();
            assert_eq!(selected.state, before.state);
            assert_eq!(selected.question, before.question);
            assert_eq!(selected.model, target());
        }
    }

    #[tokio::test]
    async fn selection_waits_for_the_current_step_and_a_cancelled_selection_never_commits() {
        let f = child(4_096).await;
        let client = f.fixture.store.client();
        let boundary = step_boundary::for_client(&client);
        let step = boundary.step_guard(&f.child).await;
        let pending = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            f.service.switch_model(f.input(&old(), &target())),
        )
        .await;
        assert!(pending.is_err(), "selection must wait for the held Step");
        assert_eq!(f.selected(), old());
        drop(step);
        tokio::task::yield_now().await;
        assert_eq!(f.selected(), old());
        let selected = f
            .service
            .switch_model(f.input(&old(), &target()))
            .await
            .unwrap();
        assert_eq!(selected.model, target());
        assert_eq!(selected.state, State::Running);
    }
}
