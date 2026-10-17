mod support;

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    session::pending,
    ycoding_schema::{
        DomainDecode, event, parse_json, session, session_message, session_pending, stringify_json,
    },
    ycoding_store::{
        KeyPart, Metadata, Options, Store, project,
        session::{InstructionStateTable, SessionTable},
        tuple_key,
    },
};
use ycoding_runtime::{Core, Production};

const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Verified\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subagents_share_location_capabilities_without_escalation() {
    tokio::time::timeout(Duration::from_secs(60), flow())
        .await
        .unwrap();
}

async fn flow() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (send, mut requests) = mpsc::unbounded_channel();
    let (stop, stopped) = oneshot::channel();
    let primary = Arc::new(AtomicUsize::new(0));
    let router = axum::Router::new().route("/chat/completions", axum::routing::post(move |headers: axum::http::HeaderMap, body: axum::body::Bytes| {
        let send = send.clone();
        let role = headers.get("x-role").unwrap().to_str().unwrap().to_owned();
        let launch = role == "parent" && primary.fetch_add(1, Ordering::SeqCst) == 0;
        async move {
            send.send((role, parse_json(std::str::from_utf8(&body).unwrap()).unwrap())).unwrap();
            let reply = if launch {
                "data: {\"id\":\"launch\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"child\",\"type\":\"function\",\"function\":{\"name\":\"subagent\",\"arguments\":\"{\\\"agent\\\":\\\"occam\\\",\\\"description\\\":\\\"Capability verification\\\",\\\"prompt\\\":\\\"Child verification\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"
            } else { TEXT };
            axum::http::Response::builder().header("content-type", "text/event-stream").body(axum::body::Body::from(reply)).unwrap()
        }
    }));
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let root = std::env::temp_dir().join(format!(
        "w11-subagents-{}-{}",
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
    std::fs::write(directory.join("ycoding.json"), format!(r#"{{"model":{{"providerID":"openai","model":"gpt-runtime"}},"experimental":{{"subagent_depth":2}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}},"capabilities":{{"tools":{{"deny":["write"]}},"builtin_instructions":{{"deny":["date"]}}}},"agents":{{"god":{{"permissions":[{{"action":"read","resource":"*","effect":"deny"}}],"request":{{"headers":{{"X-Role":"parent"}}}}}},"occam":{{"request":{{"headers":{{"X-Role":"child"}}}}}}}}}}"#)).unwrap();
    let store = Store::initialize(
        root.join("store.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([27; 16], 1),
    )
    .unwrap();
    let placement = directory.to_string_lossy().into_owned();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    store
        .submit(move |tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: placement.as_str().into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: now,
                    time_updated: now,
                    time_initialized: None,
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            let mut parent = support::record("ses_parent");
            parent.directory = placement.into();
            parent.time_created = now;
            parent.time_updated = now;
            parent.agent = Some("god".into());
            SessionTable::insert(tx, &parent)
        })
        .unwrap()
        .await
        .unwrap();
    let core = Core::production(store.client(), Production {
        analytics: roots.data.join("analytics"),
        configuration: config::LoadOptions { directory, roots: roots.clone(), project: true, file: None, content: None, env: BTreeMap::from([("OPENAI_API_KEY".into(), "synthetic-key".into())]) },
        catalog: models_dev::Options { source: "https://models.dev".into(), cache: roots.cache.join("models.json"), file: None, bundled: Some(parse_json(r#"{"openai":{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192}}}}}"#).unwrap()), fetch: false, user_agent: "ycoding-test".into() },
        cursor: None, steer: None, ripgrep: "rg".into(), meeting: false,
    }).await.unwrap();
    core.execution.prompt(pending::Request { id: session_message::Id::new("msg_parent_input").unwrap(), session_id: session::Id::new("ses_parent").unwrap(), input: session_pending::Message::decode(&parse_json(r#"{"type":"user","data":{"text":"Parent verification"},"delivery":"steer"}"#).unwrap()).unwrap(), event_id: event::Id::new("evt_parent_input").unwrap(), created: now }, Some(false)).await.unwrap();
    core.execution
        .resume(&session::Id::new("ses_parent").unwrap())
        .await
        .unwrap();
    let mut child_request = None;
    while child_request.is_none() {
        let (role, request) = tokio::time::timeout(Duration::from_secs(10), requests.recv())
            .await
            .unwrap()
            .unwrap();
        if role == "child" {
            child_request = Some(request);
        }
    }
    let ycoding_core::ycoding_schema::JsonValue::Object(request) = child_request.unwrap() else {
        panic!()
    };
    let tools = stringify_json(request.get(&"tools".into()).unwrap());
    for name in ["write", "read", "subagent", "subagent_control"] {
        assert!(
            !tools.contains(&format!("\"name\":\"{name}\"")),
            "child escalated {name}"
        );
    }
    let tasks = core
        .orchestration
        .list(&session::Id::new("ses_parent").unwrap())
        .unwrap();
    assert_eq!(tasks.len(), 1);
    let child = tasks[0].session_id.clone();
    core.execution.resume(&child).await.unwrap();
    let info = core.sessions.get(&child).unwrap().unwrap();
    assert_eq!(
        info.location,
        core.sessions
            .get(&session::Id::new("ses_parent").unwrap())
            .unwrap()
            .unwrap()
            .location
    );
    assert!(
        info.permission_ceiling
            .unwrap()
            .iter()
            .any(|rule| rule.action.as_str() == Some("read")
                && rule.effect.0.as_str() == Some("deny"))
    );
    let state = store
        .snapshot()
        .unwrap()
        .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(child.as_lossless())]))
        .unwrap()
        .unwrap()
        .current_values
        .domain()
        .unwrap();
    assert!(state.0.get(&"core/date".into()).is_none());
    assert!(state.0.get(&"core/subagent-reuse".into()).is_none());
    assert!(state.0.get(&"ycoding/workspace-memory".into()).is_some());
    core.shutdown().await.unwrap();
    store.shutdown().unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
