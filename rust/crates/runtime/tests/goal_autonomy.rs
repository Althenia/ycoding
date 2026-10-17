mod support;

use prost::{Message, Name};
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    time::timeout,
};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    session::autonomy::GoalStatus,
    ycoding_schema::{JsonValue, session, stringify_json},
    ycoding_store::{Metadata, Options, Store, session::SessionTable},
};
use ycoding_protocol::v5;
use ycoding_runtime::{Core, LocalAuth, Production};

const SYNTHESIS: &str = "data: {\"id\":\"goal\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"  Repair\\n the migration and verify the suite.  \"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"goal\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const STEER: &str = "data: {\"id\":\"steer\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Inspect the migration and run the focused checks.\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"steer\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const UNSETTLED: &str = "data: {\"id\":\"interrupted\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Partial objective\"},\"finish_reason\":null}]}\n\n";

fn change(text: &str) -> Vec<u8> {
    v5::SessionAutonomySetRequest {
        params: v5::SessionAutonomySetRequestParams {
            session_id: support::text("ses_goal"),
        },
        payload: v5::SessionAutonomySet {
            kind: Some(v5::session_autonomy_set::Kind::Value1(
                v5::SessionAutonomySetValue1 {
                    yolo: None,
                    goal: v5::SessionAutonomySetValue1Goal {
                        kind: Some(v5::session_autonomy_set_value1_goal::Kind::Value1(
                            support::text(text),
                        )),
                    },
                    max_no_progress: Some(5),
                },
            )),
        },
    }
    .encode_to_vec()
}

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("object")
    };
    object.get(&key.into()).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goals_from_the_socket_use_the_provider_and_preserve_state_on_failure_or_interruption() {
    timeout(Duration::from_secs(90), flow()).await.unwrap();
}

async fn flow() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let replies = Arc::new(Mutex::new(VecDeque::from([(200, SYNTHESIS), (200, STEER)])));
    let scripted = replies.clone();
    let (requests, mut received) = mpsc::unbounded_channel();
    let hold = Arc::new(tokio::sync::Mutex::new(None::<oneshot::Receiver<()>>));
    let held = hold.clone();
    let (stop_provider, stopped_provider) = tokio::sync::watch::channel(false);
    let stopped_requests = stopped_provider.clone();
    let router = axum::Router::new().route(
        "/chat/completions",
        axum::routing::post(move |body: axum::body::Bytes| {
            let scripted = scripted.clone();
            let requests = requests.clone();
            let held = held.clone();
            let mut stopped = stopped_requests.clone();
            async move {
                let body =
                    ycoding_core::ycoding_schema::parse_json(std::str::from_utf8(&body).unwrap())
                        .unwrap();
                let helper = stringify_json(&body).contains("Recent conversation context:");
                if helper {
                    requests.send(body).unwrap();
                    if let Some(gate) = held.lock().await.take() {
                        let _ = gate.await;
                    }
                }
                let (status, reply) = if !helper {
                    let _ = stopped.wait_for(|stopped| *stopped).await;
                    (200, STEER)
                } else {
                    scripted.lock().unwrap().pop_front().unwrap()
                };
                axum::http::Response::builder()
                    .status(status)
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(reply))
                    .unwrap()
            }
        }),
    );
    let provider = tokio::spawn(async move {
        let mut stopped = stopped_provider;
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stopped.wait_for(|stopped| *stopped).await;
            })
            .await
            .unwrap();
    });
    let root = std::env::temp_dir().join(format!(
        "goal-autonomy-{}-{}",
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
    std::fs::write(roots.config.join("ycoding.json"), format!(r#"{{"model":{{"providerID":"openai","model":"session-model"}},"efficiency":{{"helper_models":{{"goal":{{"providerID":"openai","model":"goal-role"}}}}}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}}}}"#)).unwrap();
    let catalog = roots.cache.join("models.json");
    std::fs::write(&catalog, r#"{"openai":{"id":"openai","name":"Fixture","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"session-model":{"id":"session-model","name":"Session","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":1,"output":2}},"goal-role":{"id":"goal-role","name":"Goal","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":false,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":1,"output":2}}}}}"#).unwrap();
    let store = Store::initialize(
        root.join("store.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([4; 16], 1),
    )
    .unwrap();
    let path = directory.to_str().unwrap().to_owned();
    store
        .submit(move |tx| {
            ycoding_core::ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_core::ycoding_store::project::Project {
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
            let mut row = support::record("ses_goal");
            row.directory = path.into();
            row.time_created = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            row.time_updated = row.time_created;
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .await
        .unwrap();
    let core = Core::production(
        store.client(),
        Production {
            analytics: roots.data.join("analytics"),
            configuration: config::LoadOptions {
                directory,
                roots: roots.clone(),
                project: true,
                file: None,
                content: None,
                env: BTreeMap::from([("OPENAI_API_KEY".into(), "synthetic-key".into())]),
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
    let mut services = support::services(LocalAuth::disabled(), false);
    services.core = Some(core.clone());
    let server = support::start(services, ycoding_runtime::standard().unwrap()).await;
    let mut client = support::Client::open(server.address(), &[]).await.unwrap();
    let id = session::Id::new("ses_goal").unwrap();

    let result: v5::SessionAutonomySetResult = support::success(
        client
            .call(
                "session.autonomy.set",
                support::session_scope("ses_goal"),
                change(" \u{feff}Fix the migration\u{a0} "),
            )
            .await,
    );
    assert_eq!(
        support::units(&result.data.goal.unwrap().text),
        "Repair the migration and verify the suite."
    );
    let state = core.autonomy.get(&id).unwrap();
    let goal = state.goal.unwrap();
    assert_eq!(goal.raw_text.unwrap().as_str(), Some("Fix the migration"));
    assert_eq!(
        (goal.iteration, goal.no_progress, goal.max_no_progress),
        (0, 0, 5)
    );
    let synthesis = received.recv().await.unwrap();
    assert_eq!(
        field(&synthesis, "model"),
        &JsonValue::String("goal-role".into())
    );
    let JsonValue::Array(messages) = field(&synthesis, "messages") else {
        panic!("messages")
    };
    assert_eq!(
        field(&messages[0], "content"),
        &JsonValue::String(ycoding_core::resources::agent::prompts::GOAL.into())
    );
    assert_eq!(
        field(&messages[1], "content"),
        &JsonValue::String(
            "Recent conversation context:\n(none)\n\nGoal synthesis request:\nFix the migration"
                .into()
        )
    );
    let steer = stringify_json(&received.recv().await.unwrap());
    assert!(steer.contains("Phase: start") && steer.contains("Current iteration: 0"));
    assert!(steer.contains("Active goal: Repair the migration and verify the suite."));
    let records = ycoding_core::ycoding_store::resources::requests(
        &store.client().snapshot().unwrap(),
        id.as_lossless(),
        ycoding_core::ycoding_store::IndexOrder::Ascending,
        None,
        10,
    )
    .unwrap();
    let helpers = records
        .iter()
        .filter(|entry| entry.record.source.as_str() == Some("goal"))
        .collect::<Vec<_>>();
    assert_eq!(helpers.len(), 2);
    assert!(
        helpers
            .iter()
            .all(|entry| entry.record.attempts == 1 && entry.record.agent.as_str() == Some("goal"))
    );
    assert_eq!(
        core.sessions.get(&id).unwrap().unwrap().tokens.input.get(),
        6.0
    );
    core.autonomy.stop(&id).await.unwrap();
    core.execution.interrupt(&id).await.unwrap();
    let inputs = core.sessions.context(&id).unwrap();
    let pending = core.sessions.pending_list(&id).unwrap();
    assert!(
        stringify_json(&ycoding_core::ycoding_schema::DomainEncode::encode(&inputs))
            .contains("Inspect the migration and run the focused checks.")
            || pending.iter().any(|input| stringify_json(&input.data)
                .contains("Inspect the migration and run the focused checks."))
    );

    let before = core.autonomy.snapshot(&id).unwrap();
    let history_before = core.sessions.context(&id).unwrap();
    let pending_before = core.sessions.pending_list(&id).unwrap();
    let mut empty = support::Client::open(server.address(), &[]).await.unwrap();
    empty
        .socket
        .send_binary(
            &v5::Frame {
                revision: 5,
                connection_epoch: Some(empty.epoch.clone()),
                ledger: Some(v5::LedgerClass::Normal as i32),
                delivery_ordinal: Some(1),
                body: Some(v5::frame::Body::Request(v5::Request {
                    request_id: "empty-goal".into(),
                    operation_id: support::operation("session.autonomy.set").operation_id,
                    scope: support::session_scope("ses_goal"),
                    payload: change(""),
                })),
                ..Default::default()
            }
            .encode_to_vec(),
        )
        .await;
    assert_eq!(empty.socket.expect_end().await.unwrap().0, 1002);
    assert_eq!(core.autonomy.snapshot(&id).unwrap(), before);
    {
        let error = support::rejected(
            client
                .call(
                    "session.autonomy.set",
                    support::session_scope("ses_goal"),
                    change(" \n\t\u{feff}\u{a0}"),
                )
                .await,
        );
        assert_eq!(error.type_name, v5::InvalidRequestError::full_name());
        assert_eq!(core.autonomy.snapshot(&id).unwrap(), before);
        assert_eq!(core.sessions.context(&id).unwrap(), history_before);
        assert_eq!(core.sessions.pending_list(&id).unwrap(), pending_before);
    }
    for responses in [
        vec![(500, "provider failure")],
        vec![(200, UNSETTLED)],
        vec![(200, "data: [DONE]\n\n")],
        vec![(200, SYNTHESIS), (500, "steer provider failure")],
    ] {
        let count = responses.len();
        replies.lock().unwrap().extend(responses);
        let error = support::rejected(
            client
                .call(
                    "session.autonomy.set",
                    support::session_scope("ses_goal"),
                    change("Another goal"),
                )
                .await,
        );
        assert_eq!(error.type_name, v5::UnknownError::full_name());
        let error = v5::UnknownError::decode(error.payload.as_slice()).unwrap();
        assert_eq!(
            support::units(&error.message),
            "Goal calculation failed. The existing goal was not replaced; retry when the provider is available."
        );
        assert!(support::units(error.r#ref.as_ref().unwrap()).starts_with("err_"));
        for _ in 0..count {
            received.recv().await.unwrap();
        }
        assert_eq!(core.autonomy.snapshot(&id).unwrap(), before);
        assert_eq!(core.sessions.context(&id).unwrap(), history_before);
        assert_eq!(core.sessions.pending_list(&id).unwrap(), pending_before);
    }

    let (release, gate) = oneshot::channel();
    *hold.lock().await = Some(gate);
    replies
        .lock()
        .unwrap()
        .extend([(200, SYNTHESIS), (200, STEER)]);
    let request = client
        .send(
            "session.autonomy.set",
            support::session_scope("ses_goal"),
            change("Interrupted by a stop"),
        )
        .await;
    received.recv().await.unwrap();
    core.autonomy.stop(&id).await.unwrap();
    let stopped = core.autonomy.snapshot(&id).unwrap();
    release.send(()).unwrap();
    let error = support::rejected(client.settle(&request).await);
    assert_eq!(error.type_name, v5::ConflictError::full_name());
    let error = v5::ConflictError::decode(error.payload.as_slice()).unwrap();
    assert_eq!(support::units(error.resource.as_ref().unwrap()), "ses_goal");
    assert_eq!(
        support::units(&error.message),
        "Goal changed while calculation was running. Review the current goal before retrying."
    );
    assert_eq!(core.autonomy.snapshot(&id).unwrap(), stopped);
    assert_eq!(stopped.state.goal.unwrap().status, GoalStatus::Stopped);
    server.shutdown().await.unwrap();
    core.shutdown().await.unwrap();
    stop_provider.send(true).unwrap();
    provider.await.unwrap();
    store.shutdown().unwrap();
}
