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
    Fixture {
        preflight: Preflight::new(
            sessions.clone(),
            Arc::new(agents),
            Arc::new(model::Resolver::new(catalog())),
            credentials.clone(),
        ),
        store,
        sessions,
        credentials,
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
