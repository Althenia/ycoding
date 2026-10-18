use std::{
    collections::BTreeMap,
    ops::Bound,
    sync::{Arc, Mutex},
    time::Duration,
};
use ycoding_core::{
    resources::agent,
    session::{
        autonomy::{Goal, Steer, SteerRequest},
        goal,
    },
    tools::code_mode::Cancellation,
    tools::policy::helper::{ModelSelection, Role, Settings},
};
use ycoding_schema::{DomainDecode, JsonValue, model, parse_json, session};
use ycoding_store::{KeyPart, resources::UsageTable, session::SessionTable, tuple_key};

#[path = "session_support/generation.rs"]
mod support;
use support::{Fixture, Options, Reply, field, local_with_settings, text};

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .expect("goal request settles")
}

fn model(id: &str) -> model::Ref {
    model::Ref::decode(&parse_json(&format!(r#"{{"providerID":"openai","id":"{id}"}}"#)).unwrap())
        .unwrap()
}

fn service(
    f: &Fixture,
    agent: Option<ycoding_schema::agent::Info>,
    selected: Option<ModelSelection>,
) -> goal::Service {
    let agents = Arc::new(agent::Service::new(agent.into_iter().collect()));
    let generate = Arc::new(local_with_settings(
        &f.store,
        &f.provider.address,
        Settings {
            models: selected
                .map(|selected| BTreeMap::from([(Role::Goal, selected)]))
                .unwrap_or_default(),
            ..Settings::default()
        },
    ));
    let serving = f.dependencies.location.clone();
    goal::Service::new(
        f.sessions.clone(),
        Arc::new(move |location| {
            (location == &serving).then(|| goal::Environment {
                location: serving.clone(),
                agents: agents.clone(),
                generate: generate.clone(),
            })
        }),
    )
}

fn request(id: &session::Id, latest: Option<&str>) -> SteerRequest {
    let mut goal = Goal::new(
        "Repair the migration and verify the focused suite.",
        None,
        Some(3),
    );
    goal.iteration = 2;
    goal.no_progress = 1;
    SteerRequest {
        session_id: id.clone(),
        goal,
        latest_assistant_text: latest.map(str::to_owned),
    }
}

fn message(f: &Fixture, index: usize) -> String {
    let JsonValue::Array(messages) = field(&f.provider.seen()[index], "messages") else {
        panic!("messages")
    };
    text(&field(messages.last().unwrap(), "content"))
}

#[tokio::test]
async fn goal_steers_read_the_current_session_answer_policy() {
    within(async {
        let f = Fixture::new(Options {
            goal: true,
            ..Options::default()
        })
        .await;
        let service = service(&f, Some(goal::agent()), None);
        f.provider
            .reply(Reply::Text("Continue authorized work.".into()));
        assert!(service.steer(request(&f.id, None)).await.is_some());
        assert!(message(&f, 0).contains("Automatic answering: disabled"));
        f.autonomy.set_auto_answer(&f.id, true).await.unwrap();
        f.provider
            .reply(Reply::Text("Continue authorized work.".into()));
        assert!(service.steer(request(&f.id, None)).await.is_some());
        assert!(message(&f, 1).contains("Automatic answering: enabled"));
    })
    .await;
}

#[tokio::test]
async fn synthesis_and_start_steer_match_ts_messages_and_leave_the_user_owned_state_unchanged() {
    within(async {
        let f = Fixture::new(Options { goal: true, user: Some("The project uses SQLite.".into()), ..Options::default() }).await;
        f.provider.reply(Reply::Finish(" \u{feff}Repair\n the migration and verify the suite.\u{a0} ".into(), "length"));
        let service = service(&f, Some(goal::agent()), None);
        let cancellation = Cancellation::default();
        let session = f.sessions.get(&f.id).unwrap().unwrap();
        let before = f.sessions.context(&f.id).unwrap();
        let autonomy = f.autonomy.snapshot(&f.id).unwrap();
        let text = service.synthesize(&session, "Fix the migration", &cancellation).await.unwrap();
        assert_eq!(text, "Repair the migration and verify the suite.");
        assert_eq!(message(&f, 0), "Recent conversation context:\nUser: The project uses SQLite.\nAssistant: The build is fixed.\n\nGoal synthesis request:\nFix the migration");
        f.provider.reply(Reply::Text("Inspect the migration next.".into()));
        assert_eq!(service.start(&session, &Goal::new(&text, Some("Fix the migration"), None), &cancellation).await.unwrap(), "Inspect the migration next.");
        assert_eq!(message(&f, 1), "Recent conversation context:\nUser: The project uses SQLite.\nAssistant: The build is fixed.\n\nUser-proxy steer request:\nActive goal: Repair the migration and verify the suite.\nPhase: start\nCurrent iteration: 0\nAutomatic answering: disabled\nLatest assistant response: The build is fixed.\nPreserve the active goal and produce only the next concise user-proxy steer.");
        assert_eq!(f.sessions.context(&f.id).unwrap(), before);
        assert_eq!(f.autonomy.snapshot(&f.id).unwrap(), autonomy);
        assert_eq!(f.sessions.get(&f.id).unwrap().unwrap().tokens.input.get(), 20.0);
        let records = ycoding_store::resources::requests(&f.store.snapshot().unwrap(), f.id.as_lossless(), ycoding_store::IndexOrder::Ascending, None, 10).unwrap();
        assert!(records.iter().all(|entry| entry.record.input_id.as_ref() == Some(&"msg_user".into())));
    }).await;
}

#[tokio::test]
async fn synthesis_errors_and_cancellation_never_fall_back_to_the_raw_goal() {
    within(async {
        let f = Fixture::new(Options {
            goal: true,
            ..Options::default()
        })
        .await;
        let service = service(&f, Some(goal::agent()), None);
        let session = f.sessions.get(&f.id).unwrap().unwrap();
        let before = f.autonomy.snapshot(&f.id).unwrap();
        for reply in [
            Reply::Rejected,
            Reply::Missing,
            Reply::Unsettled("Partial objective".into()),
            Reply::Text(" \u{feff}\n\u{a0}".into()),
        ] {
            f.provider.reply(reply);
            assert_eq!(
                service
                    .synthesize(&session, "Fix the migration", &Cancellation::default())
                    .await,
                Err(goal::Error::CalculationFailed)
            );
            assert_eq!(f.autonomy.snapshot(&f.id).unwrap(), before);
            f.provider.started().await;
        }
        let cancellation = Cancellation::default();
        let gate = f.provider.hold();
        let (outcome, ()) = tokio::join!(
            service.synthesize(&session, "Interrupted request", &cancellation),
            async {
                f.provider.started().await;
                cancellation.cancel();
            }
        );
        assert_eq!(outcome, Err(goal::Error::Interrupted));
        f.provider.closed(1).await;
        gate.notify_one();
        assert_eq!(f.autonomy.snapshot(&f.id).unwrap(), before);
        assert_eq!(f.ledger().len(), 5);
        assert_eq!(
            self::service(&f, None, None)
                .synthesize(&session, "Fix the migration", &Cancellation::default())
                .await,
            Err(goal::Error::ModelUnavailable)
        );
    })
    .await;
}

#[tokio::test]
async fn contextual_goal_steer_uses_the_configured_system_and_records_accounting_without_mutating_history_or_goal()
 {
    within(async {
        let f = Fixture::new(Options { goal: true, user: Some("The project uses SQLite.".into()), ..Options::default() }).await;
        f.provider.reply(Reply::Text(" \u{feff}Inspect\n the SQLite\t migration next. \u{a0}".into()));
        let mut configured = goal::agent();
        configured.system = Some("Other system".into());
        let service = service(&f, Some(configured), Some(ModelSelection::Model(model("goal-role"))));
        let before = f.sessions.context(&f.id).unwrap();
        let autonomy = f.autonomy.snapshot(&f.id).unwrap();
        assert_eq!(service.steer(request(&f.id, Some("Which migration should I inspect?"))).await.as_deref(), Some("Inspect the SQLite migration next."));
        assert_eq!(f.sessions.context(&f.id).unwrap(), before);
        assert_eq!(f.autonomy.snapshot(&f.id).unwrap(), autonomy);
        assert_eq!(f.provider.seen().len(), 1);
        let sent = &f.provider.seen()[0];
        let JsonValue::Array(messages) = field(sent, "messages") else { panic!("messages") };
        assert_eq!(text(&field(&messages[0], "content")), "Other system");
        assert!(field(sent, "tools") == JsonValue::Null || field(sent, "tools") == JsonValue::Array(vec![]));
        assert_eq!(message(&f, 0), "Recent conversation context:\nUser: The project uses SQLite.\nAssistant: The build is fixed.\n\nUser-proxy steer request:\nActive goal: Repair the migration and verify the focused suite.\nPhase: continue\nCurrent iteration: 2\nAutomatic answering: disabled\nLatest assistant response: Which migration should I inspect?\nPreserve the active goal and produce only the next concise user-proxy steer.");
        let records = ycoding_store::resources::requests(&f.store.snapshot().unwrap(), f.id.as_lossless(), ycoding_store::IndexOrder::Ascending, None, 10).unwrap();
        let row = &records[0].record;
        assert_eq!((row.source.as_str(), row.agent.as_str(), row.request, row.attempts), (Some("goal"), Some("goal"), 1, 1));
        assert_eq!(row.model.domain().unwrap(), model("goal-role"));
        assert!(!row.prompt_cache_key.to_utf8().unwrap().is_empty());
        assert!((row.cost.unwrap() - 0.00004).abs() < 1e-12);
        let ledger = f.ledger();
        assert_eq!(ledger.len(), 1);
        assert_eq!(field(&ledger[0].1, "input"), JsonValue::Number(10.0));
        assert_eq!(field(&ledger[0].1, "output"), JsonValue::Number(5.0));
        let usage = f.store.snapshot().unwrap().scan::<UsageTable>(Bound::Unbounded, Bound::Unbounded, 10).unwrap();
        assert_eq!((usage[0].logical, usage[0].physical, usage[0].helpers, usage[0].input, usage[0].output), (1, 1, 1, 10, 5));
    }).await;
}

#[tokio::test]
async fn missing_empty_unsettled_and_failed_provider_outputs_return_none_and_still_record_attempts()
{
    within(async {
        let f = Fixture::new(Options {
            goal: true,
            ..Options::default()
        })
        .await;
        let service = service(&f, Some(goal::agent()), None);
        let before = f.autonomy.snapshot(&f.id).unwrap();
        for reply in [
            Reply::Missing,
            Reply::Text(String::new()),
            Reply::Text(" \u{feff}\n\u{a0}".into()),
            Reply::Unsettled("Nonempty without settlement".into()),
            Reply::Rejected,
        ] {
            f.provider.reply(reply);
            assert!(service.steer(request(&f.id, None)).await.is_none());
        }
        assert_eq!(f.provider.seen().len(), 5);
        let records = ycoding_store::resources::requests(
            &f.store.snapshot().unwrap(),
            f.id.as_lossless(),
            ycoding_store::IndexOrder::Ascending,
            None,
            10,
        )
        .unwrap();
        assert_eq!(
            records
                .iter()
                .map(|entry| entry.record.request)
                .collect::<Vec<_>>(),
            [1, 2, 3, 4, 5]
        );
        assert!(records.iter().all(
            |entry| entry.record.source.as_str() == Some("goal") && entry.record.attempts == 1
        ));
        assert_eq!(f.autonomy.snapshot(&f.id).unwrap(), before);
    })
    .await;
}

#[tokio::test]
async fn goal_accepts_a_settled_length_finish_while_prediction_and_prompt_keep_their_stop_requirement()
 {
    within(async {
        let f = Fixture::new(Options::default()).await;
        f.provider.reply(Reply::Finish(
            "Inspect the migration next.".into(),
            "length",
        ));
        let service = service(&f, Some(goal::agent()), None);
        assert_eq!(
            service.steer(request(&f.id, None)).await.as_deref(),
            Some("Inspect the migration next.")
        );
        assert!(
            f.prediction()
                .request(&f.id, Default::default())
                .await
                .is_none()
        );
        assert!(
            f.prompts()
                .request(
                    &f.id,
                    ycoding_core::session::prompt_generator::Input {
                        intent: "Fix the migration".into(),
                        mode: ycoding_core::session::prompt_generator::Mode::Start,
                        memory: vec![]
                    }
                )
                .await
                .is_none()
        );
    })
    .await;
}

#[tokio::test]
async fn model_precedence_is_agent_then_role_then_session_then_catalog_default_without_resolution_fallback()
 {
    within(async {
        let f = Fixture::new(Options::default()).await;
        f.provider
            .reply(Reply::Text("Inspect the migration next.".into()));
        let session_id = f.id.as_lossless().clone();
        f.store
            .client()
            .submit(move |tx| {
                let mut row = tx
                    .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session_id)]))?
                    .unwrap();
                row.model = Some(ycoding_store::session::Document::from_domain(&model(
                    "goal-session",
                ))?);
                SessionTable::put(tx, &row)
            })
            .unwrap()
            .await
            .unwrap();
        for (agent_model, role, expected) in [
            (
                Some("goal-agent"),
                Some(ModelSelection::Model(model("goal-role"))),
                "goal-agent",
            ),
            (
                None,
                Some(ModelSelection::Model(model("goal-role"))),
                "goal-role",
            ),
            (None, Some(ModelSelection::Session), "goal-session"),
            (None, None, "goal-session"),
        ] {
            let mut agent = goal::agent();
            agent.model = agent_model.map(model);
            assert!(
                service(&f, Some(agent), role)
                    .steer(request(&f.id, None))
                    .await
                    .is_some()
            );
            assert_eq!(
                text(&field(f.provider.seen().last().unwrap(), "model")),
                expected
            );
        }
        let session_id = f.id.as_lossless().clone();
        f.store
            .client()
            .submit(move |tx| {
                let mut row = tx
                    .get::<SessionTable>(&tuple_key(&[KeyPart::String(&session_id)]))?
                    .unwrap();
                row.model = None;
                SessionTable::put(tx, &row)
            })
            .unwrap()
            .await
            .unwrap();
        assert!(
            service(&f, Some(goal::agent()), None)
                .steer(request(&f.id, None))
                .await
                .is_some()
        );
        assert_eq!(
            text(&field(f.provider.seen().last().unwrap(), "model")),
            "gpt-reasoning"
        );
        let mut agent = goal::agent();
        agent.model = Some(model("not-in-catalog"));
        assert!(
            service(
                &f,
                Some(agent),
                Some(ModelSelection::Model(model("goal-role")))
            )
            .steer(request(&f.id, None))
            .await
            .is_none()
        );
        assert!(
            service(
                &f,
                Some(goal::agent()),
                Some(ModelSelection::Model(model("not-in-catalog")))
            )
            .steer(request(&f.id, None))
            .await
            .is_none()
        );
        assert_eq!(f.provider.seen().len(), 5);
        assert_eq!(f.ledger().len(), 5);
    })
    .await;
}

#[tokio::test]
async fn session_location_unknown_session_missing_environment_and_missing_goal_agent_never_request_a_provider()
 {
    within(async {
        let f = Fixture::new(Options::default()).await;
        let resolved = Arc::new(Mutex::new(Vec::new()));
        let seen = resolved.clone();
        let service = goal::Service::new(
            f.sessions.clone(),
            Arc::new(move |location| {
                seen.lock().unwrap().push(location.clone());
                None
            }),
        );
        assert!(service.steer(request(&f.id, None)).await.is_none());
        assert_eq!(
            *resolved.lock().unwrap(),
            [f.sessions.get(&f.id).unwrap().unwrap().location]
        );
        assert!(
            service
                .steer(request(&session::Id::new("ses_missing").unwrap(), None))
                .await
                .is_none()
        );
        assert_eq!(resolved.lock().unwrap().len(), 1);
        assert!(
            self::service(&f, None, None)
                .steer(request(&f.id, None))
                .await
                .is_none()
        );
        let other = Fixture::new(Options {
            directory: Some("/another"),
            ..Options::default()
        })
        .await;
        assert!(
            self::service(&other, Some(goal::agent()), None)
                .steer(request(&other.id, None))
                .await
                .is_none()
        );
        assert!(f.provider.seen().is_empty() && other.provider.seen().is_empty());
    })
    .await;
}

#[tokio::test]
async fn history_and_latest_response_are_bounded_like_ts_and_none_uses_the_latest_assistant() {
    within(async {
        let f = Fixture::new(Options {
            user: Some("old user context".into()),
            assistant: Some(format!("{}tail", "a".repeat(7000))),
            ..Options::default()
        })
        .await;
        f.provider
            .reply(Reply::Text("Inspect the migration.".into()));
        let service = service(&f, Some(goal::agent()), None);
        assert!(service.steer(request(&f.id, None)).await.is_some());
        let message = message(&f, 0);
        assert!(message.starts_with(&format!(
            "Recent conversation context:\n{}tail\n\nUser-proxy",
            "a".repeat(5996)
        )));
        assert!(message.contains(&format!(
            "Latest assistant response: {}tail\n",
            "a".repeat(1996)
        )));
        assert!(!message.contains("old user context"));
        assert!(service.steer(request(&f.id, Some("   "))).await.is_some());
        assert!(self::message(&f, 1).contains("Latest assistant response: (none)"));
    })
    .await;
}
