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
    meeting::{discovery, store::MeetingDatabase},
    resources::{catalog::models_dev, config},
    session::{execution::Execution, store::Service as SessionStore},
    tools::context::Context,
    ycoding_schema::{
        DomainDecode, DomainEncode, JsonValue, location, model, parse_json, provider, session,
        session_message, session_pending, stringify_json,
    },
    ycoding_store::{
        IndexOrder, IndexQuery, KeyPart, Metadata, Options, Store, project,
        resources::{Request, RequestTable},
        session::{Document, EventTable, NewEvent, SessionTable},
        tuple_key,
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
    let hold = Arc::new(tokio::sync::Mutex::new(None::<oneshot::Receiver<()>>));
    let held = hold.clone();
    let current_catalog = Arc::new(Mutex::new(String::new()));
    let catalog_reply = current_catalog.clone();
    let discovery_status = Arc::new(std::sync::atomic::AtomicU16::new(200));
    let discovery_reply = discovery_status.clone();
    let discovery_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let discovered = discovery_calls.clone();
    let router = axum::Router::new()
        .route(
            "/catalog/api.json",
            axum::routing::get(move || {
                let body = catalog_reply.lock().unwrap().clone();
                async move { body }
            }),
        )
        .route(
            "/models",
            axum::routing::get(move || {
                let status = discovery_reply.load(std::sync::atomic::Ordering::Acquire);
                discovered.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                async move {
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        r#"{"object":"list","data":[{"id":"discovered-model"}]}"#,
                    )
                }
            }),
        )
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
                    let held = held.clone();
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
                        if let Some(release) = held.lock().await.take() {
                            let _ = release.await;
                        }
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
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root.join("other"))
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(root.join("other/.git/ycoding"), "prj_other").unwrap();
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
    let JsonValue::Object(mut project_configuration) =
        parse_json(&std::fs::read_to_string(root.join("project/ycoding.json")).unwrap()).unwrap()
    else {
        panic!()
    };
    project_configuration.insert("extensions".into(), parse_json(&format!(r#"[{{"identity":"fixture","executable":"/usr/bin/python3","args":["{}","session_request"],"grants":[{{"family":"tools","namespace":"demo","tools":["echo"],"action":"read","resources":["sessions"]}},{{"family":"session","scopes":["create","generate","command","synthetic"],"action":"read","resources":["sessions"]}}]}}]"#, concat!(env!("CARGO_MANIFEST_DIR"), "/../core/tests/extension_child.py"))).unwrap());
    project_configuration.insert(
        "commands".into(),
        parse_json(r#"{"extension_test":{"template":"Run $ARGUMENTS"}}"#).unwrap(),
    );
    std::fs::write(
        root.join("project/ycoding.json"),
        stringify_json(&JsonValue::Object(project_configuration)),
    )
    .unwrap();
    std::fs::write(&catalog_file, r#"{"openai":{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime test","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":2,"output":3}},"gpt-helper":{"id":"gpt-helper","name":"Helper test","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":false,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":1,"output":2}}}}}"#).unwrap();
    *current_catalog.lock().unwrap() = std::fs::read_to_string(&catalog_file).unwrap();
    let configuration = config::LoadOptions {
        directory: root.join("project"),
        roots: roots.clone(),
        project: true,
        file: None,
        content: None,
        env: BTreeMap::from([
            ("OPENAI_API_KEY".into(), "synthetic-key".into()),
            (
                "XDG_DATA_HOME".into(),
                root.join("xdg-data").to_str().unwrap().into(),
            ),
        ]),
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
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
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
            let mut movable = record.clone();
            movable.id = "ses_movable".into();
            SessionTable::insert(tx, &movable)?;
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
            let mut interrupted = record.clone();
            interrupted.id = "ses_interrupted".into();
            SessionTable::insert(tx, &interrupted)?;
            let mut analysis = record.clone();
            analysis.id = "ses_analysis".into();
            analysis.agent = Some("meeting-intelligence".into());
            SessionTable::insert(tx, &analysis)?;
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
    let seeded = SessionStore::new(store.client());
    for (id, type_, data) in [
        (
            "evt_interrupted_run",
            "session.execution.started.1",
            r#"{"sessionID":"ses_interrupted"}"#,
        ),
        (
            "evt_interrupted_step",
            "session.step.started.1",
            r#"{"sessionID":"ses_interrupted","assistantMessageID":"msg_interrupted","agent":"god","model":{"providerID":"openai","id":"gpt-runtime"}}"#,
        ),
    ] {
        seeded
            .publish(NewEvent {
                id: id.into(),
                aggregate_id: "ses_interrupted".into(),
                created: 2,
                type_: type_.into(),
                data: parse_json(data).unwrap(),
            })
            .await
            .unwrap();
    }
    let xdg = root.join("xdg-data");
    let meeting_directory =
        discovery::directory(&root.join("project"), Some(&xdg), &roots.home).unwrap();
    let meetings = MeetingDatabase::open(&meeting_directory.join("meetings.redb")).unwrap();
    meetings
        .create_meeting("meeting_seed", "Seeded", "ses_analysis")
        .await
        .unwrap();
    meetings.close().await.unwrap();
    let other_meeting = discovery::directory(&root.join("other"), Some(&xdg), &roots.home).unwrap();
    std::fs::create_dir_all(&other_meeting).unwrap();
    let foreign_lock = format!(r#"{{"pid":{}}}"#, std::process::id());
    std::fs::write(other_meeting.join("runtime.lock"), &foreign_lock).unwrap();
    let backup_source = root.join("store.redb");
    let backed_up_before_deletion = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed_backup = backed_up_before_deletion.clone();
    store.observe_events(move |events| {
        if events
            .iter()
            .any(|event| event.type_.as_str() == Some("session.deleted.2"))
        {
            observed_backup.store(
                ycoding_core::ycoding_store::backup::path(&backup_source).is_file()
                    && ycoding_core::ycoding_store::backup::marker(&backup_source).is_file(),
                std::sync::atomic::Ordering::Release,
            );
        }
        true
    });
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
                source: format!("{endpoint}/catalog"),
                cache: catalog_file.clone(),
                file: None,
                bundled: None,
                fetch: true,
                user_agent: "ycoding/test".into(),
            },
            cursor: None,
            steer: None,
            ripgrep: "rg".into(),
            meeting: true,
        },
    )
    .await
    .unwrap();
    assert!(
        core.execution.active().is_empty(),
        "startup must not wake reconciled or pending Sessions"
    );
    assert!(std::ptr::eq(core.execution, Execution::global().unwrap()));
    let (_, interrupted) = core
        .sessions
        .message(&session_message::Id::new("msg_interrupted").unwrap())
        .unwrap()
        .unwrap();
    let session_message::Info::Assistant(interrupted) = interrupted else {
        panic!("reconciled Step must stay an assistant message")
    };
    assert_eq!(
        interrupted.error.unwrap().r#type.as_str(),
        Some("interrupted"),
        "startup must settle the unterminated Step before serving"
    );
    assert_eq!(
        events(&store, "ses_interrupted", "session.execution.failed.1").len(),
        1
    );
    assert!(core.catalogs.is_some(), "production catalogs must resolve");
    assert!(
        core.integrations.is_some(),
        "production integrations must resolve"
    );
    assert!(
        core.provider_usage.is_some(),
        "production quota must resolve"
    );
    assert!(core.mcp.is_some(), "production MCP must resolve");
    assert!(
        core.artifacts.is_some(),
        "production artifacts must resolve"
    );
    assert!(core.browser.is_some(), "production browser must resolve");
    assert!(
        core.isolated_browser.is_some(),
        "production isolated browser must resolve"
    );
    assert!(core.platform.is_some(), "production platform must resolve");
    let (_, services) = core
        .locations
        .session(&session::Id::new("ses_production").unwrap())
        .unwrap();
    let info = services.info.clone();
    let reference = location::Ref {
        directory: info.directory.clone(),
        workspace_id: info.workspace_id.clone(),
    };
    let composed = services.production.as_ref().unwrap();
    let catalogs = (core.catalogs.as_ref().unwrap())(&info).unwrap();
    assert!(Arc::ptr_eq(&catalogs.models, &composed.models));
    assert!(Arc::ptr_eq(&catalogs.generate, &composed.generate));
    assert_eq!(
        (&catalogs.roots.home, &catalogs.roots.config),
        (&roots.home, &roots.config),
        "skill scope must classify against the backend roots"
    );
    assert!(Arc::ptr_eq(
        &(core.mcp.as_ref().unwrap())(&info).unwrap(),
        &composed.mcp
    ));
    assert!(Arc::ptr_eq(
        &(core.platform.as_ref().unwrap())(&reference).unwrap(),
        &composed.platform
    ));
    assert!(Arc::ptr_eq(
        &(core.isolated_browser.as_ref().unwrap())(&reference).unwrap(),
        &composed.isolated
    ));
    let integrations = (core.integrations.as_ref().unwrap())(&info).unwrap();
    let usage = (core.provider_usage.as_ref().unwrap())(&info).unwrap();
    assert!(
        usage
            .providers
            .iter()
            .any(|id| id.0.as_str() == Some("openai"))
    );
    let artifacts = (core.artifacts.as_ref().unwrap())(&info).unwrap();
    let unrecorded = location::Info::decode(
        &parse_json(&format!(
            r#"{{"directory":"{0}","project":{{"id":"prj_unrecorded","directory":"{0}"}}}}"#,
            root.join("unrecorded").to_str().unwrap()
        ))
        .unwrap(),
    )
    .unwrap();
    let unrecorded_reference = location::Ref {
        directory: unrecorded.directory.clone(),
        workspace_id: None,
    };
    assert!(
        (core.catalogs.as_ref().unwrap())(&unrecorded).is_err(),
        "registered catalogs must answer unavailable for a nonexistent Location"
    );
    assert!((core.integrations.as_ref().unwrap())(&unrecorded).is_err());
    assert!((core.mcp.as_ref().unwrap())(&unrecorded).is_err());
    assert!((core.provider_usage.as_ref().unwrap())(&unrecorded).is_err());
    assert!((core.artifacts.as_ref().unwrap())(&unrecorded).is_none());
    assert!((core.platform.as_ref().unwrap())(&unrecorded_reference).is_err());
    assert!((core.isolated_browser.as_ref().unwrap())(&unrecorded_reference).is_err());
    std::fs::create_dir_all(root.join("unrecorded")).unwrap();
    let resolved = core
        .locations
        .location(unrecorded.directory.as_lossless(), None)
        .unwrap();
    assert_eq!(
        resolved.info.project.id.as_lossless().as_str(),
        Some("global"),
        "a new directory resolves its filesystem identity, not the supplied Project hypothesis"
    );
    let resolved_catalog = (core.catalogs.as_ref().unwrap())(&resolved.info).unwrap();
    assert!(Arc::ptr_eq(
        &resolved_catalog.models,
        &resolved.production.as_ref().unwrap().models
    ));
    assert!(resolved_catalog.session.is_some());
    assert!(
        services
            .agents
            .get(&"meeting-intelligence".into())
            .is_some()
    );
    let descriptor = std::fs::read_to_string(meeting_directory.join("bridge.json")).unwrap();
    assert!(!other_meeting.join("bridge.json").exists());
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
    let other_info = other.info.clone();
    assert!(
        !other
            .production
            .as_ref()
            .unwrap()
            .tools
            .materialize(&other.agents.default().unwrap().permissions)
            .definitions
            .iter()
            .any(|tool| tool.name.as_str() == Some("meeting_history")),
        "a Location whose Meeting runtime failed to start keeps working without it"
    );
    assert_eq!(
        std::fs::read_to_string(other_meeting.join("runtime.lock")).unwrap(),
        foreign_lock
    );
    let other_integrations = (core.integrations.as_ref().unwrap())(&other_info).unwrap();
    assert!(Arc::ptr_eq(
        integrations.wellknown.as_ref().unwrap(),
        other_integrations.wellknown.as_ref().unwrap()
    ));
    assert!(Arc::ptr_eq(
        &usage.quota,
        &(core.provider_usage.as_ref().unwrap())(&other_info)
            .unwrap()
            .quota
    ));
    let other_artifacts = (core.artifacts.as_ref().unwrap())(&other_info).unwrap();
    assert!(
        std::ptr::eq(
            artifacts.store.accounting().unwrap(),
            other_artifacts.store.accounting().unwrap()
        ),
        "every Location must use the same artifact accounting instance"
    );
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
    assert!(ycoding_core::ycoding_store::backup::marker(&root.join("store.redb")).is_file());
    assert!(backed_up_before_deletion.load(std::sync::atomic::Ordering::Acquire));
    let restored_path = root.join("restored.redb");
    std::fs::copy(
        ycoding_core::ycoding_store::backup::path(&root.join("store.redb")),
        &restored_path,
    )
    .unwrap();
    let restored = Store::open(&restored_path, Options::core(), store.catalog()).unwrap();
    assert!(
        SessionStore::new(restored.client())
            .get(&session::Id::new("ses_idle").unwrap())
            .unwrap()
            .is_some()
    );
    restored.shutdown().unwrap();
    let mut host = support::services(LocalAuth::disabled(), false);
    host.core = Some(core.clone());
    let server = support::start(host, ycoding_runtime::standard().unwrap()).await;
    let mut wire = support::Client::open(server.address(), &[]).await.unwrap();
    production_event_sources(&core, &mut wire, &root, &store).await;
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
    let telemetry: v5::TelemetryListResult = support::success(
        wire.call(
            "telemetry.list",
            v5::Scope {
                target: Some(v5::scope::Target::Machine(v5::Empty {})),
            },
            v5::TelemetryListRequest {
                query: v5::TelemetryListRequestQuery {
                    limit: Some(10),
                    before: None,
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert!(
        telemetry.data.data.items.is_empty(),
        "the production analytics engine serves telemetry reads"
    );
    let remote: v5::RemoteGetResult = support::success(
        wire.call(
            "remote.get",
            v5::Scope {
                target: Some(v5::scope::Target::Machine(v5::Empty {})),
            },
            v5::RemoteGetRequest {}.encode_to_vec(),
        )
        .await,
    );
    assert_eq!(
        remote.data.state, 1,
        "production composes an opted-out remote control"
    );
    assert!(remote.data.device.is_none());
    assert!(
        artifacts.store.accounting().is_some(),
        "Session movement can use the shared artifact accounting owner"
    );
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
    let before_generate = core
        .sessions
        .model_history(&session::Id::new("ses_production").unwrap())
        .unwrap()
        .len();
    let generated: v5::SessionGenerateResult = support::success(
        wire.call(
            "session.generate",
            support::session_scope("ses_production"),
            v5::SessionGenerateRequest {
                params: v5::SessionGenerateRequestParams {
                    session_id: support::text("ses_production"),
                },
                payload: v5::SessionGenerateRequestPayload {
                    prompt: support::text("Generate without admitting another prompt"),
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert_eq!(
        generated.data.data.text,
        support::text("Run the focused tests")
    );
    let generated_request = stringify_json(&received.recv().await.unwrap());
    assert!(generated_request.contains("Generate without admitting another prompt"));
    assert!(!generated_request.contains(r#""tools""#));
    assert_eq!(
        core.sessions
            .model_history(&session::Id::new("ses_production").unwrap())
            .unwrap()
            .len(),
        before_generate
    );
    let moved: v5::SessionMoveResult = support::success(
        wire.call(
            "session.move",
            support::session_scope("ses_movable"),
            v5::SessionMoveRequest {
                params: v5::SessionMoveRequestParams {
                    session_id: support::text("ses_movable"),
                },
                payload: v5::LocationRef {
                    directory: support::text(root.join("other").to_str().unwrap()),
                    workspace_id: None,
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert_eq!(moved.data, v5::Empty {});
    let moved = core
        .sessions
        .get(&session::Id::new("ses_movable").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(moved.location.directory, other_info.directory);
    assert_eq!(moved.project_id, other_info.project.id);
    let (_, moved_location) = core.locations.session(&moved.id).unwrap();
    let (moved_catalogs, moved_services) = core.session_services(&moved_location).unwrap();
    assert!(Arc::ptr_eq(
        moved_services.runner.models(),
        &moved_catalogs.models
    ));
    assert_eq!(moved_services.generate.location, moved.location);

    let adopted_directory = root.join("adopted");
    std::fs::create_dir_all(&adopted_directory).unwrap();
    assert!(
        std::process::Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&adopted_directory)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        std::process::Command::new("git")
            .args([
                "remote",
                "add",
                "origin",
                "https://example.invalid/session-move.git"
            ])
            .current_dir(&adopted_directory)
            .status()
            .unwrap()
            .success()
    );
    std::fs::write(adopted_directory.join(".git/ycoding"), "prj_previous").unwrap();
    let adopted_id = ycoding_core::platform::project_identity::remote_id(
        "https://example.invalid/session-move.git",
    )
    .unwrap();
    let mut previous_project = store
        .client()
        .snapshot()
        .unwrap()
        .get::<project::ProjectTable>(&tuple_key(&[KeyPart::String(&"prj_other".into())]))
        .unwrap()
        .unwrap();
    previous_project.id = "prj_previous".into();
    previous_project.worktree = adopted_directory.to_str().unwrap().into();
    core.sessions
        .record_project(previous_project, None)
        .await
        .unwrap();
    let definition = ycoding_core::ycoding_schema::project_artifact::Definition::decode(&parse_json(
        r#"{"kind":"skill","name":"Move review","description":"Adopted project review","content":"Review project changes."}"#,
    ).unwrap()).unwrap();
    let adopted_artifact = artifacts
        .store
        .write_manual(
            ycoding_core::resources::project_artifact::store::ManualWriteInput {
                scope: ycoding_core::ycoding_schema::project_artifact::ScopeSelector::Project,
                project_id: Some(
                    ycoding_core::ycoding_schema::project::Id::new("prj_previous").unwrap(),
                ),
                id: "move-review",
                definition: &definition,
                expected: None,
                now: 1,
            },
        )
        .unwrap();
    let before_adoption = artifacts
        .store
        .get(
            &adopted_artifact.scope_id,
            &adopted_artifact.kind,
            &adopted_artifact.id,
        )
        .unwrap();
    let ycoding_core::ycoding_schema::project_artifact::Scope::Project(previous_scope) =
        &before_adoption.artifact.scope
    else {
        panic!("project scope")
    };
    std::fs::remove_file(
        ycoding_core::resources::project_artifact::package::scope_marker_path(
            &roots
                .data
                .join("project-artifacts")
                .join(previous_scope.storage_id.as_lossless().as_str().unwrap()),
        ),
    )
    .unwrap();
    let _: v5::SessionMoveResult = support::success(
        wire.call(
            "session.move",
            support::session_scope("ses_movable"),
            v5::SessionMoveRequest {
                params: v5::SessionMoveRequestParams {
                    session_id: support::text("ses_movable"),
                },
                payload: v5::LocationRef {
                    directory: support::text(adopted_directory.to_str().unwrap()),
                    workspace_id: None,
                },
            }
            .encode_to_vec(),
        )
        .await,
    );
    let after_adoption = artifacts
        .store
        .get(
            &adopted_artifact.scope_id,
            &adopted_artifact.kind,
            &adopted_artifact.id,
        )
        .unwrap();
    assert_eq!(
        after_adoption.current_version,
        before_adoption.current_version
    );
    assert_eq!(after_adoption.definition, before_adoption.definition);
    let ycoding_core::ycoding_schema::project_artifact::Scope::Project(scope) =
        after_adoption.artifact.scope
    else {
        panic!("project scope")
    };
    assert_eq!(
        scope.project_id.as_lossless().as_str(),
        Some(adopted_id.as_str())
    );
    let marker = ycoding_core::resources::project_artifact::package::scope_marker_path(
        &roots
            .data
            .join("project-artifacts")
            .join(scope.storage_id.as_lossless().as_str().unwrap()),
    );
    assert_eq!(
        parse_json(&std::fs::read_to_string(marker).unwrap()).unwrap(),
        ycoding_core::ycoding_schema::ObjectEncoder::new()
            .field("schema", &1.0)
            .field("scopeID", &scope.id)
            .field("type", "project")
            .field("storageID", &scope.storage_id)
            .finish()
    );
    let adopted_session = core
        .sessions
        .get(&session::Id::new("ses_movable").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        adopted_session.project_id.as_lossless().as_str(),
        Some(adopted_id.as_str())
    );
    assert_eq!(
        adopted_session.location.directory.as_lossless().as_str(),
        adopted_directory.to_str()
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
            "browser",
            "computer",
            "decision",
            "demo_echo",
            "edit",
            "glob",
            "goal",
            "grep",
            "meeting_history",
            "memory",
            "patch",
            "project_artifact",
            "question",
            "read",
            "shell",
            "skill",
            "subagent",
            "subagent_control",
            "subagent_report",
            "task_complete",
            "todowrite",
            "webfetch",
            "websearch",
            "worktree",
            "write",
            "execute"
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
    let other_shell = other
        .production
        .as_ref()
        .unwrap()
        .tools
        .materialize(&other.agents.default().unwrap().permissions)
        .invoke(
            "shell",
            parse_json(r#"{"command":"printf other-shell"}"#).unwrap(),
            Context::new("ses_other_location", "god", "msg_other", "call_other_shell").unwrap(),
        )
        .await
        .unwrap();
    assert!(other_shell.error.is_none());
    assert_eq!(
        core.execution.jobs().get("call_other_shell").unwrap().kind,
        "shell",
        "every Location must share the one process-global Jobs owner"
    );
    let todos = tools
        .invoke(
            "todowrite",
            parse_json(r#"{"todos":[{"content":"Verify the composition","status":"pending","priority":"high"}]}"#).unwrap(),
            Context::new("ses_production", "god", "msg_tool", "call_todos").unwrap(),
        )
        .await
        .unwrap();
    assert!(todos.error.is_none(), "{:?}", todos.error);
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
    assert_eq!(
        core.sessions
            .get(&session::Id::new("ses_production").unwrap())
            .unwrap()
            .unwrap()
            .title
            .as_str(),
        Some("Respond with the verification result"),
        "first prompt titles must run through the production Session runner"
    );
    assert!(
        encoded.contains(r#""name":"subagent""#),
        "Session tools reach the model"
    );
    assert!(
        !encoded.contains("subagent_report"),
        "a root Session is not offered the managed-child report tool"
    );
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
    let definition = ycoding_core::ycoding_schema::project_artifact::Definition::decode(&parse_json(r#"{"kind":"skill","name":"Review","description":"Reusable review","content":"Review the current change."}"#).unwrap()).unwrap();
    let preview = artifacts
        .store
        .preview_manual(
            ycoding_core::resources::project_artifact::store::ManualPreviewInput {
                id: "review",
                definition: &definition,
                expected: None,
                now: now(),
            },
        )
        .unwrap();
    assert!(
        other_artifacts
            .store
            .confirm_manual(&preview.token, now())
            .is_ok(),
        "every Location must share one artifact source and confirmation owner"
    );
    core.locations.reload(&info).unwrap();
    assert_eq!(
        std::fs::read_to_string(meeting_directory.join("bridge.json")).unwrap(),
        descriptor,
        "the Meeting runtime must survive a Location reload"
    );
    let (_, reloaded) = core
        .locations
        .session(&session::Id::new("ses_production").unwrap())
        .unwrap();
    assert!(!Arc::ptr_eq(
        &reloaded.production.as_ref().unwrap().tools,
        &services.production.as_ref().unwrap().tools
    ));
    assert!(
        reloaded
            .production
            .as_ref()
            .unwrap()
            .tools
            .materialize(&reloaded.agents.default().unwrap().permissions)
            .definitions
            .iter()
            .any(|tool| tool.name.as_str() == Some("meeting_history"))
    );
    prompt_input(
        core.execution,
        "ses_analysis",
        "evt_analysis_prompt",
        "Summarize the seeded meeting",
    )
    .await;
    core.execution
        .resume(&session::Id::new("ses_analysis").unwrap())
        .await
        .unwrap();
    let request = received.recv().await.unwrap();
    let encoded = stringify_json(&request);
    assert!(encoded.contains("You analyze meetings and propose engineering plans"));
    assert!(encoded.contains("Summarize the seeded meeting"));
    assert!(
        !encoded.contains("\"tools\""),
        "analysis requests must carry no tools"
    );
    let JsonValue::Object(body) = &request else {
        panic!("provider request must be an object");
    };
    let Some(JsonValue::Array(messages)) = body.get(&"messages".into()) else {
        panic!("provider request must carry messages");
    };
    assert_eq!(
        messages.len(),
        2,
        "analysis keeps only its system prompt and the bounded input"
    );

    let browser_status = tools
        .invoke(
            "browser",
            parse_json(r#"{"operation":"status"}"#).unwrap(),
            Context::new("ses_production", "god", "msg_tool", "call_browser_status").unwrap(),
        )
        .await
        .unwrap();
    assert!(browser_status.error.is_none(), "{:?}", browser_status.error);
    assert!(
        core.isolated_browser.as_ref().unwrap()(&location::Ref {
            directory: info.directory.clone(),
            workspace_id: info.workspace_id.clone(),
        })
        .unwrap()
        .status(
            &ycoding_core::ycoding_schema::session_id::SessionId::new("ses_production").unwrap()
        )
        .await
        .unwrap()
        .instance_id
        .is_none(),
        "Location composition does not launch Chrome"
    );

    prompt_input(
        core.execution,
        "ses_other_location",
        "evt_advisory_first",
        "Establish a completed boundary",
    )
    .await;
    core.execution
        .resume(&session::Id::new("ses_other_location").unwrap())
        .await
        .unwrap();
    while received.try_recv().is_ok() {}
    std::fs::write(root.join("other/ycoding.json"), r#"{"agents":{"god":{"description":"other agent"}},"compaction":{"advisory":{"consider_percent":1,"strongly_advised_percent":2}}}"#).unwrap();
    core.locations.reload(&other_info).unwrap();
    store
        .submit(|tx| {
            ycoding_core::ycoding_store::session::RevisionTable::put(
                tx,
                &ycoding_core::ycoding_store::session::Revision {
                    session_id: "ses_other_location".into(),
                    revision: 0,
                    parent_revision: None,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activation_event_id: None,
                    activation_sequence: None,
                    time_created: 0,
                },
            )?;
            ycoding_core::ycoding_store::session::ContextStateTable::put(
                tx,
                &ycoding_core::ycoding_store::session::ContextState {
                    session_id: "ses_other_location".into(),
                    status: "active".into(),
                    revision: 0,
                    manifest_digest: None,
                    covered_through_message_id: None,
                    covered_through_seq: None,
                    activated_event_id: None,
                    time_activated: None,
                    error_code: None,
                },
            )
        })
        .unwrap()
        .await
        .unwrap();
    prompt_input(
        core.execution,
        "ses_other_location",
        "evt_advisory_second",
        &format!("Continue after the advisory {}", "x".repeat(20_000)),
    )
    .await;
    core.execution
        .resume(&session::Id::new("ses_other_location").unwrap())
        .await
        .unwrap();
    let advisory = events(
        &store,
        "ses_other_location",
        "session.compaction.admitted.2",
    );
    assert_eq!(
        advisory.len(),
        1,
        "the production runner consumes its compaction Advisor once on rising pressure"
    );
    let job_id =
        ycoding_core::ycoding_schema::ObjectDecoder::new(&advisory[0].data, &Default::default())
            .unwrap()
            .field("jobID")
            .unwrap();
    assert_eq!(
        core.sessions
            .compaction_job(&job_id)
            .unwrap()
            .unwrap()
            .trigger
            .as_str(),
        Some("advised")
    );
    assert!(
        core.sessions
            .compaction_pending(&session::Id::new("ses_other_location").unwrap())
            .await
            .unwrap()
            .is_empty(),
        "advisory work must settle, not remain queued forever"
    );
    let advisory_requests = std::iter::from_fn(|| received.try_recv().ok())
        .map(|request| stringify_json(&request))
        .collect::<Vec<_>>();
    assert!(
        advisory_requests
            .iter()
            .any(|request| request.contains("Continue after the advisory"))
    );
    assert!(
        advisory_requests
            .iter()
            .all(|request| !request.contains(r#""name":"conversation_compact""#))
    );

    let stale = composed
        .tools
        .materialize(&[])
        .invoke(
            "demo_echo",
            parse_json(r#"{"op":"generate","session":"ses_production"}"#).unwrap(),
            Context::new(
                "ses_production",
                "god",
                "msg_extension_tool",
                "call_extension_stale",
            )
            .unwrap(),
        )
        .await
        .unwrap();
    assert!(stale.error.is_none());
    assert_eq!(
        stale.output.unwrap().structured,
        parse_json(r#"{"failure":1}"#).unwrap()
    );
    for operation in ["create", "command", "synthetic", "generate"] {
        let settlement = reloaded.production.as_ref().unwrap().tools.materialize(&[]).invoke(
            "demo_echo",
            parse_json(&format!(r#"{{"op":"{operation}","session":"ses_extension","parent":"ses_production","message":"msg_extension_{operation}","command":"extension_test"}}"#)).unwrap(),
            Context::new("ses_production", "god", "msg_extension_tool", &format!("call_extension_{operation}")).unwrap(),
        ).await.unwrap();
        assert!(
            settlement.error.is_none(),
            "{operation}: {:?}",
            settlement.error
        );
        let reply = stringify_json(&settlement.output.unwrap().structured);
        assert!(!reply.contains("failure"), "{operation}: {reply}");
        if operation == "generate" {
            assert!(reply.contains("Run the focused tests"), "{reply}");
            let request = stringify_json(&received.recv().await.unwrap());
            assert!(request.contains("Generate only"));
            assert!(!request.contains(r#""tools":[{"#));
        }
    }
    let extension_session = session::Id::new("ses_extension").unwrap();
    let extension_info = core.sessions.get(&extension_session).unwrap().unwrap();
    assert_eq!(
        extension_info.parent_id,
        Some(session::Id::new("ses_production").unwrap())
    );
    assert_eq!(
        extension_info.location,
        core.sessions
            .get(&session::Id::new("ses_production").unwrap())
            .unwrap()
            .unwrap()
            .location
    );
    assert_eq!(
        core.sessions
            .pending_list(&extension_session)
            .unwrap()
            .len(),
        2
    );
    assert!(
        core.sessions
            .latest(&extension_session, "assistant")
            .unwrap()
            .is_none()
    );

    let platform = composed.platform.clone();
    let background = tools
        .invoke(
            "shell",
            parse_json(r#"{"command":"sleep 30","background":true}"#).unwrap(),
            Context::new("ses_production", "god", "msg_tool", "call_background").unwrap(),
        )
        .await
        .unwrap();
    assert!(background.error.is_none());
    let pid = platform
        .shell
        .list()
        .into_iter()
        .find(|shell| shell.command.as_str() == Some("sleep 30"))
        .and_then(|shell| shell.pid)
        .unwrap()
        .get();
    RefreshFlow {
        core: &core,
        root: &root,
        endpoint: &endpoint,
        catalog: &current_catalog,
        status: &discovery_status,
        calls: &discovery_calls,
        hold: &hold,
        received: &mut received,
        wire: &mut wire,
    }
    .run()
    .await;
    let (release_held, held_reply) = oneshot::channel();
    *hold.lock().await = Some(held_reply);
    prompt_input(
        core.execution,
        "ses_production",
        "evt_inflight_prompt",
        "Keep working until shutdown",
    )
    .await;
    core.execution
        .wake(&session::Id::new("ses_production").unwrap())
        .unwrap();
    assert!(
        stringify_json(&received.recv().await.unwrap()).contains("Keep working until shutdown")
    );
    server.shutdown().await.unwrap();
    core.shutdown().await.unwrap();
    assert!(core.execution.active().is_empty());
    assert!(
        events(&store, "ses_production", "session.execution.interrupted.1")
            .last()
            .is_some_and(|event| stringify_json(&event.data).contains(r#""reason":"shutdown""#)),
        "the in-flight drain must settle durably before the Store closes"
    );
    assert_eq!(
        events(&store, "ses_production", "session.step.started.1").len(),
        events(&store, "ses_production", "session.step.ended.1").len()
            + events(&store, "ses_production", "session.step.failed.1").len(),
        "every started Step must settle before the Store closes"
    );
    assert!(platform.shell.list().is_empty());
    assert!(
        !std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .status()
            .unwrap()
            .success(),
        "a background shell must not outlive shutdown"
    );
    assert!(!meeting_directory.join("bridge.json").exists());
    assert!(!meeting_directory.join("runtime.lock").exists());
    assert_eq!(
        std::fs::read_to_string(other_meeting.join("runtime.lock")).unwrap(),
        foreign_lock
    );
    assert!(
        core.locations
            .location(&directory.clone().into(), None)
            .is_err()
    );
    assert_eq!(
        events(&store, "ses_interrupted", "session.step.started.1").len(),
        1,
        "restart must never replay the interrupted provider attempt"
    );
    drop(release_held);
    stop_model.send(()).unwrap();
    model_server.await.unwrap();
    store.shutdown().unwrap();
}

struct RefreshFlow<'a> {
    core: &'a Core,
    root: &'a std::path::Path,
    endpoint: &'a str,
    catalog: &'a Arc<Mutex<String>>,
    status: &'a Arc<std::sync::atomic::AtomicU16>,
    calls: &'a Arc<std::sync::atomic::AtomicUsize>,
    hold: &'a Arc<tokio::sync::Mutex<Option<oneshot::Receiver<()>>>>,
    received: &'a mut mpsc::UnboundedReceiver<JsonValue>,
    wire: &'a mut support::Client,
}

impl RefreshFlow<'_> {
    async fn run(&mut self) {
        let (_, first) = self
            .core
            .locations
            .session(&session::Id::new("ses_production").unwrap())
            .unwrap();
        let (_, other) = self
            .core
            .locations
            .session(&session::Id::new("ses_other_location").unwrap())
            .unwrap();
        let again = self
            .core
            .locations
            .location(first.info.directory.as_lossless(), None)
            .unwrap();
        assert!(Arc::ptr_eq(
            &first.production.as_ref().unwrap().models,
            &again.production.as_ref().unwrap().models
        ));
        let catalog = self.core.catalogs.as_ref().unwrap();
        let original = catalog(&first.info).unwrap();
        let generator = original.generate.clone();
        let (release, waiting) = oneshot::channel();
        *self.hold.lock().await = Some(waiting);
        let held = tokio::spawn(async move {
            generator
                .text(ycoding_core::resources::generate::Input {
                    prompt: "Held old-generation request".into(),
                    model: Some(model::Ref {
                        provider_id: provider::Id("openai".into()),
                        id: "gpt-runtime".into(),
                        profile: None,
                        variant: None,
                    }),
                })
                .await
        });
        assert!(
            stringify_json(&self.received.recv().await.unwrap())
                .contains("Held old-generation request")
        );
        {
            let mut current = self.catalog.lock().unwrap();
            *current = current.replace("Runtime test", "Current catalog");
        }
        let path = self.root.join("project/ycoding.json");
        let JsonValue::Object(mut configuration) =
            parse_json(&std::fs::read_to_string(&path).unwrap()).unwrap()
        else {
            panic!()
        };
        let JsonValue::Object(mut providers) =
            configuration.get(&"providers".into()).unwrap().clone()
        else {
            panic!()
        };
        providers.insert("local".into(), parse_json(&format!(r#"{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"baseURL":"{}","apiKey":"synthetic-key"}},"catalog":{{"source":"openai-models"}}}}"#, self.endpoint)).unwrap());
        configuration.insert("providers".into(), JsonValue::Object(providers));
        configuration.insert(
            "experimental".into(),
            parse_json(
                r#"{"policies":[{"action":"provider.use","resource":"local","effect":"deny"}]}"#,
            )
            .unwrap(),
        );
        let notified = Arc::new(Notify::new());
        let wake = notified.clone();
        let updates = self
            .core
            .events
            .subscribe(Scope::Global, None, move || wake.notify_one())
            .unwrap();
        std::fs::write(
            &path,
            stringify_json(&JsonValue::Object(configuration.clone())),
        )
        .unwrap();
        (original.refresh)().await.unwrap();
        let current = catalog(&first.info).unwrap();
        assert!(!Arc::ptr_eq(&current.models, &original.models));
        assert!(
            !current
                .models
                .catalog()
                .provider_permitted(&provider::Id("local".into()))
        );
        assert!(
            !current
                .models
                .catalog()
                .integrations()
                .iter()
                .any(|reference| reference.provider_id.0.as_str() == Some("local"))
        );
        assert_eq!(
            self.calls.load(std::sync::atomic::Ordering::Acquire),
            0,
            "denied discovery must have no HTTP effects"
        );
        assert!(
            current
                .models
                .catalog()
                .providers
                .iter()
                .flat_map(|provider| &provider.models)
                .any(|model| model.name.as_str() == Some("Current catalog"))
        );
        timeout(Duration::from_secs(5), async {
            loop {
                if catalog(&other.info)
                    .unwrap()
                    .models
                    .catalog()
                    .providers
                    .iter()
                    .flat_map(|provider| &provider.models)
                    .any(|model| model.name.as_str() == Some("Current catalog"))
                {
                    break;
                }
                notified.notified().await;
                while updates.next().unwrap().is_some() {}
            }
        })
        .await
        .unwrap();
        let table = self.root.join("mcp-refresh.json");
        std::fs::write(&table, format!(r#"{{"log":"{}","capabilities":{{"tools":{{}}}},"responses":{{"tools/list":{{"":{{"tools":[{{"name":"retained","inputSchema":{{"type":"object"}}}}]}}}}}}}}"#, table.with_extension("log").display())).unwrap();
        let mcp = parse_json(&format!(
            r#"{{"servers":{{"refresh":{{"type":"local","command":["python3","{}","{}"]}}}}}}"#,
            concat!(env!("CARGO_MANIFEST_DIR"), "/../core/tests/mcp_table.py"),
            table.display()
        ))
        .unwrap();
        configuration.insert(
            "experimental".into(),
            parse_json(
                r#"{"policies":[{"action":"provider.use","resource":"local","effect":"allow"}]}"#,
            )
            .unwrap(),
        );
        configuration.insert("mcp".into(), mcp.clone());
        let JsonValue::Object(mut agents) = configuration.get(&"agents".into()).unwrap().clone()
        else {
            panic!()
        };
        agents.insert("pending-owner".into(), parse_json(r#"{"description":"Pending owner","permissions":[{"action":"*","resource":"*","effect":"ask"}]}"#).unwrap());
        configuration.insert("agents".into(), JsonValue::Object(agents));
        std::fs::write(
            &path,
            stringify_json(&JsonValue::Object(configuration.clone())),
        )
        .unwrap();
        (current.refresh)().await.unwrap();
        let usable = catalog(&first.info).unwrap();
        assert!(
            usable
                .models
                .catalog()
                .available(&self.core.credentials.all().unwrap())
                .iter()
                .any(|model| model.id.as_str() == Some("discovered-model"))
        );
        let (_, owner) = self
            .core
            .locations
            .session(&session::Id::new("ses_production").unwrap())
            .unwrap();
        let mcp_owner = owner.production.as_ref().unwrap().mcp.clone();
        assert!(
            mcp_owner
                .tools()
                .await
                .unwrap()
                .iter()
                .any(|tool| tool.definition["name"] == "retained")
        );
        assert!(Arc::ptr_eq(
            &first.production.as_ref().unwrap().platform.shell,
            &owner.production.as_ref().unwrap().platform.shell
        ));
        assert!(Arc::ptr_eq(
            &first.production.as_ref().unwrap().platform.pty,
            &owner.production.as_ref().unwrap().platform.pty
        ));
        self.replies_across_reload(&owner, &usable).await;
        let usable = catalog(&first.info).unwrap();
        configuration.insert("mcp".into(), parse_json(r#"{"servers":{"refresh":{"type":"local","command":["/ycoding-nonexistent-mcp"]}}}"#).unwrap());
        self.status.store(500, std::sync::atomic::Ordering::Release);
        std::fs::write(
            &path,
            stringify_json(&JsonValue::Object(configuration.clone())),
        )
        .unwrap();
        assert!((usable.refresh)().await.is_err());
        assert!(
            Arc::ptr_eq(&usable.models, &catalog(&first.info).unwrap().models),
            "failed discovery retains the complete usable generation"
        );
        assert!(
            mcp_owner
                .tools()
                .await
                .unwrap()
                .iter()
                .any(|tool| tool.definition["name"] == "retained"),
            "a later composition failure must not mutate shared MCP definitions"
        );
        self.status.store(200, std::sync::atomic::Ordering::Release);
        assert!(
            (usable.refresh)().await.is_err(),
            "failed MCP replacement cannot publish success"
        );
        assert!(Arc::ptr_eq(
            &usable.models,
            &catalog(&first.info).unwrap().models
        ));
        assert!(
            mcp_owner
                .tools()
                .await
                .unwrap()
                .iter()
                .any(|tool| tool.definition["name"] == "retained"),
            "failed replacement restores the prior real MCP process"
        );
        configuration.insert("mcp".into(), mcp);
        std::fs::write(&path, stringify_json(&JsonValue::Object(configuration))).unwrap();
        (usable.refresh)().await.unwrap();
        release.send(()).unwrap();
        assert_eq!(
            held.await.unwrap().unwrap().as_str(),
            Some("Run the focused tests")
        );
    }

    async fn replies_across_reload(
        &mut self,
        owner: &ycoding_runtime::LocationServices,
        catalog: &ycoding_runtime::CatalogServices,
    ) {
        use ycoding_core::{
            process::guardrails::Input,
            tools::policy::questions::Admission,
            ycoding_schema::{form, permission, question},
        };
        let id = session::Id::new("ses_production").unwrap();
        let permission = owner.permissions.ask(permission::Request::decode(&parse_json(r#"{"id":"per_held_generation","sessionID":"ses_production","action":"read","resources":["asset"]}"#).unwrap()).unwrap(), Some("pending-owner".into())).unwrap().wait.unwrap();
        let Admission::Pending(question) = owner.questions.ask(question::Request::decode(&parse_json(r#"{"id":"que_held_generation","sessionID":"ses_production","questions":[{"question":"Continue?","header":"Choose","options":[{"label":"One","description":"Continue"}]}]}"#).unwrap()).unwrap()).unwrap() else { panic!() };
        let form = owner.forms.ask(form::Info::decode(&parse_json(r#"{"id":"frm_held_generation","sessionID":"ses_production","title":"Continue","fields":[{"key":"name","type":"string","required":false}]}"#).unwrap()).unwrap()).unwrap();
        let review = owner
            .guardrails
            .assert(Input {
                session_id: id,
                action: "shell".into(),
                resources: vec![
                    format!(
                        "rm -rf '{}'",
                        std::fs::canonicalize(self.root.join("project"))
                            .unwrap()
                            .display()
                    )
                    .into(),
                ],
                metadata: None,
                skip_review: false,
                holder: None,
            })
            .unwrap();
        let JsonValue::String(request_id) = review.request.as_ref().unwrap().id.encode() else {
            panic!()
        };
        let request_id = support::text(request_id.as_str().unwrap());
        let review = review.wait.unwrap();
        (catalog.refresh)().await.unwrap();
        let scope = support::session_scope("ses_production");
        let permissions: v5::SessionPermissionListResult = support::success(
            self.wire
                .call(
                    "session.permission.list",
                    scope.clone(),
                    v5::SessionPermissionListRequest {
                        params: v5::SessionPermissionListRequestParams {
                            session_id: support::text("ses_production"),
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(
            permissions
                .data
                .items
                .iter()
                .any(|request| support::units(&request.id) == "per_held_generation")
        );
        let _: v5::SessionPermissionReplyResult = support::success(
            self.wire
                .call(
                    "session.permission.reply",
                    scope.clone(),
                    v5::SessionPermissionReplyRequest {
                        params: v5::SessionPermissionReplyRequestParams {
                            session_id: support::text("ses_production"),
                            request_id: support::text("per_held_generation"),
                        },
                        payload: v5::SessionPermissionReplyRequestPayload {
                            reply: v5::PermissionReply::Once as i32,
                            message: None,
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        let _: v5::SessionQuestionReplyResult = support::success(
            self.wire
                .call(
                    "session.question.reply",
                    scope.clone(),
                    v5::SessionQuestionReplyRequest {
                        params: v5::SessionQuestionReplyRequestParams {
                            session_id: support::text("ses_production"),
                            request_id: support::text("que_held_generation"),
                        },
                        payload: v5::QuestionReply {
                            answers: v5::QuestionReplyAnswers {
                                items: vec![v5::QuestionAnswer {
                                    items: vec![support::text("One")],
                                }],
                            },
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        let _: v5::SessionFormReplyResult = support::success(
            self.wire
                .call(
                    "session.form.reply",
                    support::wire::form_scope("ses_production"),
                    v5::SessionFormReplyRequest {
                        params: v5::SessionFormReplyRequestParams {
                            session_id: support::text("ses_production"),
                            form_id: support::text("frm_held_generation"),
                        },
                        payload: v5::FormReply {
                            answer: v5::FormAnswer {
                                entries: Vec::new(),
                            },
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        let _: v5::SessionGuardrailRequestReplyResult = support::success(
            self.wire
                .call(
                    "session.guardrail.request.reply",
                    scope,
                    v5::SessionGuardrailRequestReplyRequest {
                        params: v5::SessionGuardrailRequestReplyRequestParams {
                            session_id: support::text("ses_production"),
                            request_id,
                        },
                        payload: v5::SessionGuardrailRequestReplyRequestPayload {
                            reply: v5::GuardrailReply::Once as i32,
                        },
                    }
                    .encode_to_vec(),
                )
                .await,
        );
        assert!(permission.await.unwrap().is_ok());
        assert_eq!(
            question.await.unwrap().unwrap(),
            vec![vec![ycoding_core::ycoding_schema::LosslessString::from(
                "One"
            )]]
        );
        assert!(matches!(form.await.unwrap(), form::State::Answered(_)));
        assert!(review.await.unwrap().is_ok());
    }
}

async fn prompt_input(execution: &Execution, session: &str, event: &str, text: &str) {
    let event = ycoding_core::ycoding_schema::event::Id::new(event).unwrap();
    execution
        .prompt(
            ycoding_core::session::pending::Request {
                id: session_message::Id::from_event(&event),
                session_id: session::Id::new(session).unwrap(),
                input: session_pending::Message::decode(
                    &parse_json(&format!(
                        r#"{{"type":"user","delivery":"steer","data":{{"text":"{text}"}}}}"#
                    ))
                    .unwrap(),
                )
                .unwrap(),
                event_id: event,
                created: now(),
            },
            Some(false),
        )
        .await
        .unwrap();
}

async fn production_event_sources(
    core: &Core,
    wire: &mut support::Client,
    root: &std::path::Path,
    store: &Store,
) {
    let configuration = format!(
        r#"{{"mcp":{{"servers":{{"owned":{{"type":"local","disabled":true,"command":["python3","{}","{}"]}}}}}}}}"#,
        concat!(env!("CARGO_MANIFEST_DIR"), "/../core/tests/mcp_table.py"),
        root.join("event-mcp.json").display()
    );
    let first_directory = root.join("event-first");
    let second_directory = root.join("event-second");
    for directory in [&first_directory, &second_directory] {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("ycoding.json"), &configuration).unwrap();
    }
    let first = core
        .locations
        .location(&first_directory.to_str().unwrap().into(), None)
        .unwrap();
    scoped_catalog_queries(wire, first_directory.to_str().unwrap()).await;
    let second = core
        .locations
        .location(&second_directory.to_str().unwrap().into(), None)
        .unwrap();
    scoped_catalog_queries(wire, second_directory.to_str().unwrap()).await;
    assert!(!Arc::ptr_eq(
        &first.production.as_ref().unwrap().models,
        &second.production.as_ref().unwrap().models
    ));
    core.locations.reload(&first.info).unwrap();
    let reloaded = core
        .locations
        .location(first.info.directory.as_lossless(), None)
        .unwrap();
    assert!(!Arc::ptr_eq(
        &first.production.as_ref().unwrap().models,
        &reloaded.production.as_ref().unwrap().models
    ));
    scoped_catalog_queries(wire, first_directory.to_str().unwrap()).await;
    scoped_catalog_queries(wire, second_directory.to_str().unwrap()).await;

    let types = [
        "catalog.updated",
        "integration.updated",
        "mcp.status.changed",
        "shell.created",
    ];
    let observed = core
        .events
        .subscribe_types(Scope::Global, &types, || {})
        .unwrap();
    let foreign = Feed::attach(&store.client());
    let excluded = foreign
        .subscribe_types(Scope::Global, &types, || {})
        .unwrap();
    for held in [&first, &second, &reloaded] {
        let composed = held.production.as_ref().unwrap();
        let mut catalog = composed.models.catalog().as_ref().clone();
        catalog.set_default(None);
        composed.integrations.reload().unwrap();
        composed.mcp.disconnect("owned").await.unwrap();
        let mut prepared = composed
            .platform
            .shell
            .prepare(
                ycoding_core::ycoding_schema::shell::CreateInput::decode(
                    &parse_json(r#"{"command":"printf scoped-event","timeout":1000}"#).unwrap(),
                )
                .unwrap(),
                &composed.configuration,
            )
            .unwrap();
        let shell = composed.platform.shell.create(&mut prepared).await.unwrap();
        composed.platform.shell.wait(&shell.id).await.unwrap();
        composed.platform.shell.remove(&shell.id).await.unwrap();
    }
    let publications = std::iter::from_fn(|| observed.next().unwrap())
        .map(|item| {
            let ycoding_core::event_feed::Payload::Ephemeral(event) = &item.payload else {
                panic!("scoped ephemeral event expected");
            };
            (
                event.data.name().to_owned(),
                event.location.as_ref().unwrap().directory.clone(),
            )
        })
        .collect::<Vec<_>>();
    for name in types {
        assert_eq!(
            publications
                .iter()
                .filter(|(kind, directory)| kind == name && directory == &first.info.directory)
                .count(),
            2,
            "held and reloaded first-Location generations retain their own {name} delivery"
        );
        assert_eq!(
            publications
                .iter()
                .filter(|(kind, directory)| kind == name && directory == &second.info.directory)
                .count(),
            1,
            "second Location owns its {name} delivery"
        );
    }
    assert!(
        excluded.next().unwrap().is_none(),
        "Location services must not publish to another feed attached to the same Store"
    );
    drop(first);
    drop(reloaded);
    core.locations
        .evict(&first_directory.to_str().unwrap().into(), None)
        .unwrap();
    let reacquired = core
        .locations
        .location(&first_directory.to_str().unwrap().into(), None)
        .unwrap();
    scoped_catalog_queries(wire, first_directory.to_str().unwrap()).await;
    assert_eq!(
        reacquired.info.directory.as_lossless().as_str(),
        first_directory.to_str()
    );
}

async fn scoped_catalog_queries(wire: &mut support::Client, directory: &str) {
    use support::wire::{location_scope, query};
    let scope = location_scope(directory);
    let query = query(directory, None);
    let models: v5::ModelListResult = support::success(
        wire.call(
            "model.list",
            scope.clone(),
            v5::ModelListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    assert!(!models.data.items.is_empty());
    let _: v5::ProviderListResult = support::success(
        wire.call(
            "provider.list",
            scope.clone(),
            v5::ProviderListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::AgentListResult = support::success(
        wire.call(
            "agent.list",
            scope.clone(),
            v5::AgentListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::CommandListResult = support::success(
        wire.call(
            "command.list",
            scope.clone(),
            v5::CommandListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::ReferenceListResult = support::success(
        wire.call(
            "reference.list",
            scope.clone(),
            v5::ReferenceListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::SkillListResult = support::success(
        wire.call(
            "skill.list",
            scope.clone(),
            v5::SkillListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::IntegrationListResult = support::success(
        wire.call(
            "integration.list",
            scope.clone(),
            v5::IntegrationListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::McpListResult = support::success(
        wire.call(
            "mcp.list",
            scope.clone(),
            v5::McpListRequest {
                query: query.clone(),
            }
            .encode_to_vec(),
        )
        .await,
    );
    let _: v5::ShellListResult = support::success(
        wire.call(
            "shell.list",
            scope,
            v5::ShellListRequest { query }.encode_to_vec(),
        )
        .await,
    );
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn events(
    store: &Store,
    session: &str,
    type_: &str,
) -> Vec<ycoding_core::ycoding_store::session::Event> {
    let prefix = tuple_key(&[
        KeyPart::String(&session.into()),
        KeyPart::String(&type_.into()),
    ]);
    store
        .client()
        .snapshot()
        .unwrap()
        .index_range::<EventTable>(
            "event_aggregate_type_seq_idx",
            IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|entry| entry.record)
        .collect()
}

fn prompt(session: &str) -> Vec<u8> {
    v5::SessionPromptGenerateRequest {
        params: v5::SessionPromptGenerateRequestParams { session_id: support::text(session) },
        payload: v5::SessionPromptGenerateRequestPayload { mode: v5::SessionPromptGenerateRequestPayloadMode::SessionPromptgenerateRequestPayloadModeStart as i32, intent: support::text("Verify this change"), memory: v5::SessionPromptGenerateRequestPayloadMemory { items: vec![] } },
    }.encode_to_vec()
}
