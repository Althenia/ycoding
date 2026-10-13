mod support;

use prost::Message;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{Notify, mpsc, oneshot},
    time::timeout,
};
use ycoding_core::{
    event_feed::{Feed, Scope},
    resources::{catalog::models_dev, config},
    tools::context::Context,
    ycoding_schema::{DomainDecode, model, parse_json, provider, session, session_pending},
    ycoding_store::{
        Metadata, Options, Store, project,
        resources::{Request, RequestTable},
        session::{Document, SessionTable},
    },
};
use ycoding_protocol::v5;
use ycoding_runtime::{Core, LocalAuth, Production};

const REPLY: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Run the focused tests\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disk_configuration_composes_location_helpers() {
    timeout(Duration::from_secs(60), production_flow())
        .await
        .unwrap();
}

async fn production_flow() {
    let model_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", model_listener.local_addr().unwrap());
    let (requests, mut received) = mpsc::unbounded_channel();
    let replies = Arc::new(Mutex::new(VecDeque::<(u16, &'static str)>::new()));
    let scripted = replies.clone();
    let router = axum::Router::new()
        .route(
            "/fixture",
            axum::routing::get(|| async { "local fetch result" }),
        )
        .route(
            "/chat/completions",
            axum::routing::post(
                move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
                    let requests = requests.clone();
                    let scripted = scripted.clone();
                    async move {
                        assert_eq!(
                            headers.get("authorization").unwrap(),
                            "Bearer synthetic-key"
                        );
                        let mut body = parse_json(std::str::from_utf8(&body).unwrap()).unwrap();
                        if let ycoding_core::ycoding_schema::JsonValue::Object(body) = &mut body {
                            body.insert(
                                "_observedAgentHeader".into(),
                                ycoding_core::ycoding_schema::JsonValue::String(
                                    headers
                                        .get("x-agent")
                                        .and_then(|value| value.to_str().ok())
                                        .unwrap_or("")
                                        .into(),
                                ),
                            );
                        }
                        requests.send(body).unwrap();
                        let (status, reply) =
                            scripted.lock().unwrap().pop_front().unwrap_or((200, REPLY));
                        axum::http::Response::builder()
                            .status(status)
                            .header(
                                "content-type",
                                if status == 200 {
                                    "text/event-stream"
                                } else {
                                    "application/json"
                                },
                            )
                            .body(axum::body::Body::from(reply))
                            .unwrap()
                    }
                },
            ),
        );
    let (stop_model, stopped_model) = oneshot::channel::<()>();
    let model_server = tokio::spawn(async move {
        axum::serve(model_listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped_model.await;
            })
            .await
            .unwrap();
    });
    let root = std::env::temp_dir().join(format!(
        "composition_{}_{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let roots = config::Roots::development(&root).unwrap();
    roots.initialize().unwrap();
    std::fs::create_dir_all(root.join("project")).unwrap();
    std::fs::create_dir_all(root.join("other")).unwrap();
    std::fs::write(roots.config.join("ycoding.json"), format!(r#"{{"session_retention":{{"days":2}},"model":{{"providerID":"openai","model":"gpt-runtime"}},"efficiency":{{"helper_models":{{"prompt":{{"providerID":"openai","model":"gpt-helper"}}}}}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}},"agents":{{"prediction":{{"description":"configured prediction"}},"god":{{"request":{{"headers":{{"X-Agent":"configured-agent"}},"body":{{"temperature":0.2}}}}}}}}}}"#)).unwrap();
    std::fs::write(
        root.join("project/ycoding.json"),
        r#"{"session_retention":{"days":999},"providers":{"openai":{"body":{"test_overlay":{"kept":"model","selected":"model"}}}},"agents":{"god":{"description":"project agent","request":{"body":{"seed":7,"stop":["stop-fixture"],"test_overlay":{"selected":"agent"}}}},"invalid":{"request":{"headers":{"X-Agent":"\ud800"}}},"invalid_generation":{"request":{"body":{"temperature":"hot"}}},"invalid_stop":{"request":{"body":{"stop":7}}},"invalid_stop_item":{"request":{"body":{"stop":[7]}}},"prompt":{"model":{"providerID":"openai","model":"gpt-runtime"}}}}"#,
    )
    .unwrap();
    std::fs::write(
        root.join("other/ycoding.json"),
        r#"{"agents":{"god":{"description":"other agent"}}}"#,
    )
    .unwrap();
    let catalog_file = roots.cache.join("models.json");
    std::fs::write(&catalog_file, r#"{"openai":{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime test","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":2,"output":3}},"gpt-helper":{"id":"gpt-helper","name":"Helper test","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":false,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":1,"output":2}}}}}"#).unwrap();
    let configuration = config::LoadOptions {
        directory: root.join("project"),
        roots: roots.clone(),
        project: true,
        file: None,
        content: None,
        env: BTreeMap::from([("OPENAI_API_KEY".into(), "synthetic-key".into())]),
    };
    assert!(
        config::Configuration::load(configuration.clone())
            .unwrap()
            .diagnostics
            .is_empty(),
        "{:?}",
        config::Configuration::load(configuration.clone())
            .unwrap()
            .diagnostics
    );
    let store = Store::initialize(
        root.join("store.redb"),
        Options::core(),
        support::CATALOG,
        Metadata::new([8; 16], 1),
    )
    .unwrap();
    let directory = root.join("project").to_str().unwrap().to_owned();
    let directory_copy = directory.clone();
    let other_directory = root.join("other").to_str().unwrap().to_owned();
    store
        .submit(move |tx| {
            let mut project = project::Project {
                id: "prj_one".into(),
                worktree: directory_copy.clone().into(),
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
            };
            project.time_updated = 2;
            project::ProjectTable::insert(tx, &project)?;
            let mut other_project = project.clone();
            other_project.id = "prj_other".into();
            other_project.worktree = other_directory.clone().into();
            project::ProjectTable::insert(tx, &other_project)?;
            let mut other = support::record("ses_other_location");
            other.project_id = "prj_other".into();
            other.directory = other_directory.into();
            other.time_updated = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            other.model = Some(
                Document::from_domain(&model::Ref {
                    provider_id: provider::Id("openai".into()),
                    id: "gpt-runtime".into(),
                    profile: None,
                    variant: None,
                })
                .unwrap(),
            );
            SessionTable::insert(tx, &other)?;
            let mut record = support::record("ses_production");
            record.directory = directory_copy.into();
            record.time_updated = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            SessionTable::insert(tx, &record)?;
            for agent in [
                "invalid",
                "invalid_generation",
                "invalid_stop",
                "invalid_stop_item",
            ] {
                let mut invalid = record.clone();
                invalid.id = format!("ses_{agent}").into();
                invalid.agent = Some(agent.into());
                SessionTable::insert(tx, &invalid)?;
            }
            let mut idle = record.clone();
            idle.id = "ses_idle".into();
            idle.time_updated = record.time_updated - 3 * 86400000;
            idle.time_created = idle.time_updated;
            SessionTable::insert(tx, &idle)?;
            let unpriced = Request {
                id: "req_unpriced".into(),
                session_id: "ses_production".into(),
                input_id: None,
                assistant_message_id: None,
                connection_identity_digest: None,
                source: "step".into(),
                agent: "god".into(),
                model: Document::from_domain(&model::Ref {
                    provider_id: provider::Id("openai".into()),
                    id: "gpt-runtime".into(),
                    profile: None,
                    variant: None,
                })
                .unwrap(),
                route_id: "compatible".into(),
                prompt_cache_key: "namespace_fixture".into(),
                system_digest: "system".into(),
                tool_digest: "tools".into(),
                request: 1,
                attempts: 1,
                invalidation: "first-request".into(),
                continuation: "full".into(),
                cache_read_reported: None,
                timing: None,
                cost: None,
                tokens: Document::new(
                    parse_json(
                        r#"{"input":100,"output":10,"reasoning":0,"cache":{"read":0,"write":0}}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                time_created: record.time_updated,
            };
            RequestTable::insert(tx, &unpriced)?;
            let mut recorded = unpriced.clone();
            recorded.id = "req_recorded".into();
            recorded.request = 2;
            recorded.cost = Some(0.75);
            RequestTable::insert(tx, &recorded)
        })
        .unwrap()
        .await
        .unwrap();
    let _reports = support::report_support::start(store.client());
    let retention = Feed::attach(&store.client());
    let notified = Arc::new(Notify::new());
    let wake = notified.clone();
    let deleted = retention
        .subscribe(
            Scope::Session(session::Id::new("ses_idle").unwrap()),
            None,
            move || wake.notify_one(),
        )
        .unwrap();
    let core = Core::production(
        store.client(),
        Production {
            configuration,
            catalog: models_dev::Options {
                source: "https://models.dev/api.json".into(),
                cache: roots.cache.join("catalog.json"),
                file: Some(catalog_file),
                bundled: None,
                fetch: false,
                user_agent: "ycoding/test".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
        },
    )
    .await
    .unwrap();
    let (_, services) = core
        .locations
        .session(&session::Id::new("ses_production").unwrap())
        .unwrap();
    assert!(
        services.prediction.is_some(),
        "disk-composed Locations must provide prediction"
    );
    assert!(
        services.prompts.is_some(),
        "disk-composed Locations must provide prompt generation"
    );
    assert_eq!(
        services
            .agents
            .get(&"prediction".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("configured prediction")
    );
    assert!(services.agents.get(&"prompt".into()).is_some());
    for id in [
        "GSD",
        "architech",
        "god",
        "yangi",
        "occam",
        "omoikane",
        "wittgenstein",
        "zeus",
        "btw",
        "compaction",
        "title",
        "goal",
        "prediction",
        "prompt",
        "decision",
        "summary",
    ] {
        assert!(
            services.agents.get(&id.into()).is_some(),
            "production built-in missing: {id}"
        );
    }
    assert_eq!(services.agents.default().unwrap().id.as_str(), Some("god"));
    assert_eq!(
        services
            .agents
            .get(&"god".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("project agent")
    );
    assert!(services.production.as_ref().unwrap().steer.is_none());
    let (_, other) = core
        .locations
        .session(&session::Id::new("ses_other_location").unwrap())
        .unwrap();
    assert_eq!(
        other
            .agents
            .get(&"god".into())
            .unwrap()
            .description
            .as_ref()
            .unwrap()
            .as_str(),
        Some("other agent")
    );
    assert!(!Arc::ptr_eq(
        &services.production.as_ref().unwrap().models,
        &other.production.as_ref().unwrap().models
    ));
    assert!(!Arc::ptr_eq(
        &services.production.as_ref().unwrap().tools,
        &other.production.as_ref().unwrap().tools
    ));
    let canonical = core
        .locations
        .location(&format!("{directory}/sub/..").into(), None)
        .unwrap();
    assert!(Arc::ptr_eq(
        &services.production.as_ref().unwrap().tools,
        &canonical.production.as_ref().unwrap().tools
    ));
    if deleted.next().unwrap().is_none() {
        notified.notified().await;
    }
    assert!(
        core.sessions
            .get(&session::Id::new("ses_idle").unwrap())
            .unwrap()
            .is_none(),
        "boot retention must use global days, not project days"
    );
    let mut host = support::services(LocalAuth::disabled(), false);
    host.core = Some(core.clone());
    let server = support::start(host, ycoding_runtime::standard().unwrap()).await;
    let mut wire = support::Client::open(server.address(), &[]).await.unwrap();
    let usage: v5::SessionUsageResult = support::success(
        wire.call(
            "session.usage",
            support::session_scope("ses_production"),
            v5::SessionUsageRequest {
                params: v5::SessionUsageRequestParams {
                    session_id: support::text("ses_production"),
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert_eq!(usage.data.cost, Some(0.75023));
    let report: v5::SessionUsageReportResult = support::success(wire.call("session.usageReport", support::session_scope("ses_production"), v5::SessionUsageReportRequest { params: v5::SessionUsageReportRequestParams { session_id: support::text("ses_production") }, query: v5::SessionUsageReportRequestQuery { group: v5::SessionUsageReportRequestQueryGroup::SessionUsagereportRequestQueryGroupModel as i32, time_zone: None, from: None, to: None, offset: None, limit: None, sort: None, order: None } }.encode_to_vec()).await);
    assert_eq!(report.data.total.cost, Some(0.75023));
    assert_eq!(
        store
            .client()
            .snapshot()
            .unwrap()
            .get::<RequestTable>(&ycoding_core::ycoding_store::tuple_key(&[
                ycoding_core::ycoding_store::KeyPart::String(&"req_recorded".into())
            ]))
            .unwrap()
            .unwrap()
            .cost,
        Some(0.75)
    );
    assert_eq!(
        store
            .client()
            .snapshot()
            .unwrap()
            .get::<RequestTable>(&ycoding_core::ycoding_store::tuple_key(&[
                ycoding_core::ycoding_store::KeyPart::String(&"req_unpriced".into())
            ]))
            .unwrap()
            .unwrap()
            .cost,
        None,
        "catalog pricing must stay read-only"
    );
    let prediction: v5::SessionPredictionResult = support::success(
        wire.call(
            "session.prediction",
            support::session_scope("ses_production"),
            v5::SessionPredictionRequest {
                params: v5::SessionPredictionRequestParams {
                    session_id: support::text("ses_production"),
                },
                payload: v5::SessionPredictionRequestPayload {
                    hint: None,
                    memory: v5::SessionPredictionRequestPayloadMemory { items: vec![] },
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert!(matches!(
        prediction.data.data.kind,
        Some(v5::session_prediction_response_data::Kind::Value2(_))
    ));
    assert!(
        received.try_recv().is_err(),
        "ineligible prediction must not request a model"
    );
    let result: v5::SessionPromptGenerateResult = support::success(wire.call("session.promptGenerate", support::session_scope("ses_production"), v5::SessionPromptGenerateRequest {
        params: v5::SessionPromptGenerateRequestParams { session_id: support::text("ses_production") },
        payload: v5::SessionPromptGenerateRequestPayload { mode: v5::SessionPromptGenerateRequestPayloadMode::SessionPromptgenerateRequestPayloadModeStart as i32, intent: support::text("Verify this change"), memory: v5::SessionPromptGenerateRequestPayloadMemory { items: vec![] } },
    }.encode_to_vec()).await);
    match result.data.data.kind.unwrap() {
        v5::session_prompt_generate_response_data::Kind::Value1(draft) => {
            assert_eq!(support::units(&draft.text), "Run the focused tests")
        }
        _ => panic!("production prompt generation was unavailable"),
    }
    let request = received.recv().await.unwrap();
    let encoded = ycoding_core::ycoding_schema::stringify_json(&request);
    assert!(encoded.contains("gpt-runtime"));
    assert!(!encoded.contains("\"tools\""));
    let generated: v5::SessionPromptGenerateResult = support::success(
        wire.call(
            "session.promptGenerate",
            support::session_scope("ses_other_location"),
            prompt("ses_other_location"),
        )
        .await,
    );
    assert!(matches!(
        generated.data.data.kind,
        Some(v5::session_prompt_generate_response_data::Kind::Value1(_))
    ));
    assert!(
        ycoding_core::ycoding_schema::stringify_json(&received.recv().await.unwrap())
            .contains("gpt-helper"),
        "configured helper must win over the Session model"
    );
    for reply in [
        (
            500,
            r#"{"error":{"message":"fixture failure","type":"server_error"}}"#,
        ),
        (
            200,
            "data: {\"id\":\"limited\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Incomplete prompt\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n",
        ),
    ] {
        replies.lock().unwrap().push_back(reply);
        let result: v5::SessionPromptGenerateResult = support::success(
            wire.call(
                "session.promptGenerate",
                support::session_scope("ses_other_location"),
                prompt("ses_other_location"),
            )
            .await,
        );
        assert!(matches!(
            result.data.data.kind,
            Some(v5::session_prompt_generate_response_data::Kind::Value2(_))
        ));
        received.recv().await.unwrap();
        assert!(
            received.try_recv().is_err(),
            "helper failure must not silently start another request"
        );
    }
    assert!(
        core.sessions
            .pending_list(&session::Id::new("ses_production").unwrap())
            .unwrap()
            .is_empty(),
        "helper drafts must not admit input"
    );
    let tools = services
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&services.agents.default().unwrap().permissions);
    let names = tools
        .definitions
        .iter()
        .map(|tool| tool.name.as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "edit",
            "glob",
            "grep",
            "memory",
            "patch",
            "project_artifact",
            "read",
            "shell",
            "webfetch",
            "websearch",
            "worktree",
            "write"
        ]
    );
    let shell = tools
        .invoke(
            "shell",
            parse_json(r#"{"command":"printf production-shell"}"#).unwrap(),
            Context::new("ses_production", "god", "msg_tool", "call_shell").unwrap(),
        )
        .await
        .unwrap();
    assert!(shell.error.is_none());
    let shell = shell.output.unwrap();
    assert!(shell.content.iter().any(|part| matches!(part, ycoding_core::ycoding_schema::llm::ToolContent::Text(text) if text.text.as_str().is_some_and(|text| text.contains("production-shell")))));
    assert_eq!(
        core.execution.jobs().get("call_shell").unwrap().kind,
        "shell",
        "factory shell must use Execution's Jobs"
    );
    let fetched = tools
        .invoke(
            "webfetch",
            parse_json(&format!(r#"{{"url":"{endpoint}/fixture"}}"#)).unwrap(),
            Context::new("ses_production", "god", "msg_tool", "call_fetch").unwrap(),
        )
        .await
        .unwrap();
    assert!(fetched.error.is_none());
    assert!(
        ycoding_core::ycoding_schema::stringify_json(&fetched.output.unwrap().structured)
            .contains("local fetch result")
    );
    let event = ycoding_core::ycoding_schema::event::Id::new("evt_production_prompt").unwrap();
    core.execution.prompt(ycoding_core::session::pending::Request { id: ycoding_core::ycoding_schema::session_message::Id::from_event(&event), session_id: session::Id::new("ses_production").unwrap(), input: session_pending::Message::decode(&parse_json(r#"{"type":"user","delivery":"steer","data":{"text":"Respond with the verification result"}}"#).unwrap()).unwrap(), event_id: event, created: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 }, Some(false)).await.unwrap();
    core.execution
        .resume(&session::Id::new("ses_production").unwrap())
        .await
        .unwrap();
    let request = received.recv().await.unwrap();
    let encoded = ycoding_core::ycoding_schema::stringify_json(&request);
    assert!(encoded.contains("Respond with the verification result"));
    assert!(encoded.contains("configured-agent"));
    assert!(encoded.contains("\"temperature\":0.2"));
    let ycoding_core::ycoding_schema::JsonValue::Object(body) = &request else {
        panic!("provider request must be an object");
    };
    assert_eq!(
        body.get(&"_observedAgentHeader".into()),
        Some(&parse_json(r#""configured-agent""#).unwrap())
    );
    assert_eq!(body.get(&"seed".into()), Some(&parse_json("7").unwrap()));
    assert_eq!(
        body.get(&"stop".into()),
        Some(&parse_json(r#"["stop-fixture"]"#).unwrap())
    );
    assert_eq!(
        body.get(&"test_overlay".into()),
        Some(&parse_json(r#"{"kept":"model","selected":"agent"}"#).unwrap())
    );
    let prediction: v5::SessionPredictionResult = support::success(
        wire.call(
            "session.prediction",
            support::session_scope("ses_production"),
            v5::SessionPredictionRequest {
                params: v5::SessionPredictionRequestParams {
                    session_id: support::text("ses_production"),
                },
                payload: v5::SessionPredictionRequestPayload {
                    hint: Some(support::text("tests")),
                    memory: v5::SessionPredictionRequestPayloadMemory { items: vec![] },
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert!(matches!(
        prediction.data.data.kind,
        Some(v5::session_prediction_response_data::Kind::Value1(_))
    ));
    assert!(
        ycoding_core::ycoding_schema::stringify_json(&received.recv().await.unwrap())
            .contains("Predict a likely next message")
    );
    for agent in [
        "invalid",
        "invalid_generation",
        "invalid_stop",
        "invalid_stop_item",
    ] {
        let invalid = session::Id::new(format!("ses_{agent}")).unwrap();
        let failed = core.execution.resume(&invalid).await.unwrap_err();
        assert!(matches!(
            failed,
            ycoding_core::session::run_coordinator::Error::Runner(error)
                if error.r#type == "agent.request".into()
        ));
        assert!(received.try_recv().is_err());
        assert!(core.sessions.model_history(&invalid).unwrap().is_empty());
    }
    server.shutdown().await.unwrap();
    core.shutdown().await.unwrap();
    stop_model.send(()).unwrap();
    model_server.await.unwrap();
}

fn prompt(session: &str) -> Vec<u8> {
    v5::SessionPromptGenerateRequest {
        params: v5::SessionPromptGenerateRequestParams { session_id: support::text(session) },
        payload: v5::SessionPromptGenerateRequestPayload { mode: v5::SessionPromptGenerateRequestPayloadMode::SessionPromptgenerateRequestPayloadModeStart as i32, intent: support::text("Verify this change"), memory: v5::SessionPromptGenerateRequestPayloadMemory { items: vec![] } },
    }.encode_to_vec()
}
