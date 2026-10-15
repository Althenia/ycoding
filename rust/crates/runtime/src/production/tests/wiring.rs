use super::*;
use ycoding_core::{
    session::{pending, run_coordinator::Coordinator},
    ycoding_schema::{event, session_pending, stringify_json},
    ycoding_store::{KeyPart, session::InstructionStateTable, tuple_key},
};

const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Finished\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

async fn admit(f: &Fixture, session: &str, suffix: &str) {
    f.sessions().admit(pending::Request {
        id: ycoding_core::ycoding_schema::session_message::Id::new(format!("msg_{suffix}")).unwrap(),
        session_id: session::Id::new(session).unwrap(),
        input: session_pending::Message::decode(&parse_json(r#"{"type":"user","data":{"text":"Run the requested check"},"delivery":"steer"}"#).unwrap()).unwrap(),
        event_id: event::Id::new(format!("evt_{suffix}")).unwrap(),
        created: crate::ids::now_millis(),
    }).await.unwrap();
}

async fn provider(
    replies: Vec<String>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    oneshot::Sender<()>,
    JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let replies = Arc::new(Mutex::new(std::collections::VecDeque::from(replies)));
    let (stop, stopped) = oneshot::channel();
    let router = axum::Router::new().route(
        "/chat/completions",
        axum::routing::post(move |body: axum::body::Bytes| {
            let send = send.clone();
            let reply = replies
                .lock()
                .unwrap()
                .pop_front()
                .expect("unexpected provider call");
            async move {
                send.send(parse_json(std::str::from_utf8(&body).unwrap()).unwrap())
                    .unwrap();
                axum::http::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(reply))
                    .unwrap()
            }
        }),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    (endpoint, receive, stop, task)
}

fn policy(endpoint: &str, capabilities: &str) -> String {
    format!(
        r#"{{"model":{{"providerID":"openai","model":"gpt-runtime"}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}},"capabilities":{capabilities}}}"#
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_settlement_does_not_reload_configuration_without_another_step() {
    let mut f = fixture("{}", "{}");
    let source = f.roots.config.join("explicit.json");
    std::fs::write(&source, "{}").unwrap();
    Arc::get_mut(&mut f.factory).unwrap().options.file = Some(source.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    std::fs::write(f.directory().join("ycoding.json"), policy(&endpoint, "{}")).unwrap();
    let router = axum::Router::new().route(
        "/chat/completions",
        axum::routing::post(move || {
            std::fs::rename(&source, source.with_extension("saved")).unwrap();
            std::fs::create_dir(&source).unwrap();
            async {
                axum::http::Response::builder()
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(TEXT))
                    .unwrap()
            }
        }),
    );
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let locations = f.locations();
    let services = f.services(&locations);
    admit(&f, "ses_one", "idle").await;
    let result = Coordinator::new(Arc::new(
        services.production.as_ref().unwrap().runner.clone(),
    ))
    .run(&session::Id::new("ses_one").unwrap())
    .await;
    drop(services);
    locations.close().unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
    assert!(
        result.is_ok(),
        "settled idle work must not fail a nonexistent next step: {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn next_step_reload_applies_capabilities_and_removes_old_guidance() {
    let reply = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_read\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\\\"asset.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
    let (endpoint, mut requests, stop, server) =
        provider(vec![reply.into(), TEXT.into(), TEXT.into(), TEXT.into()]).await;
    let f = fixture("{}", &policy(&endpoint, "{}"));
    let table = f.directory().join("mcp-table.json");
    std::fs::write(&table, format!(r#"{{"capabilities":{{"tools":{{}},"resources":{{}},"extensions":{{"io.modelcontextprotocol/skills":{{"directoryRead":true}}}}}},"instructions":"W11 MCP requirement","responses":{{"tools/list":{{"":{{"tools":[{{"name":"lookup","description":"Lookup","inputSchema":{{"type":"object","properties":{{}}}}}}]}}}},"resources/list":{{"":{{"resources":[]}}}},"skills/list":{{"":{{"resultType":"complete","ttlMs":0,"cacheScope":"server","skills":[{{"uri":"skill://allowed/SKILL.md","frontmatter":{{"name":"allowed","description":"Allowed MCP skill"}},"resources":"dynamic"}},{{"uri":"skill://hidden/SKILL.md","frontmatter":{{"name":"hidden","description":"Hidden MCP skill"}},"resources":"dynamic"}}]}}}}}},"log":"{}"}}"#, table.with_extension("log").display())).unwrap();
    let hidden = ycoding_core::resources::mcp::skills::id(
        &"table".into(),
        &"skill://hidden/SKILL.md".into(),
    );
    let initial_capabilities = format!(r#"{{"skills":{{"deny":["{hidden}"]}}}}"#);
    let configured = |capabilities: &str| {
        let JsonValue::Object(mut configuration) =
            parse_json(&policy(&endpoint, capabilities)).unwrap()
        else {
            panic!()
        };
        configuration.insert(
            "mcp".into(),
            parse_json(&format!(
                r#"{{"servers":{{"table":{{"type":"local","command":["python3","{}","{}"]}}}}}}"#,
                concat!(env!("CARGO_MANIFEST_DIR"), "/../core/tests/mcp_table.py"),
                table.display()
            ))
            .unwrap(),
        );
        stringify_json(&JsonValue::Object(configuration))
    };
    std::fs::write(
        f.directory().join("ycoding.json"),
        configured(&initial_capabilities),
    )
    .unwrap();
    std::fs::write(f.directory().join("AGENTS.md"), "W11 ambient requirement").unwrap();
    std::fs::write(f.directory().join("asset.txt"), "Real file result").unwrap();
    let locations = f.locations();
    let services = f.services(&locations);
    let composed = services.production.as_ref().unwrap();
    let mcp = composed.mcp.clone();
    let path = f.directory().join("ycoding.json");
    let changed = configured(
        r#"{"instructions":{"project":false},"skills":{"enabled":false},"tools":{"deny":["read","memory","project_artifact","execute"]},"builtin_instructions":{"deny":["date"]}}"#,
    );
    let generate = composed.session_generate.clone();
    let _hook = composed.tools.hooks.after(Arc::new(move |result| {
        let path = path.clone();
        let changed = changed.clone();
        let generate = generate.clone();
        Box::pin(async move {
            std::fs::write(path, changed).unwrap();
            generate
                .generate(
                    &session::Id::new("ses_one").unwrap(),
                    "Draft verification".into(),
                    &Default::default(),
                )
                .await
                .unwrap();
            Ok(result)
        })
    }));
    admit(&f, "ses_one", "reload").await;
    Coordinator::new(Arc::new(composed.runner.clone()))
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let first = requests.recv().await.unwrap();
    let helper = stringify_json(&requests.recv().await.unwrap());
    let second = requests.recv().await.unwrap();
    let before = stringify_json(&first);
    let after = stringify_json(&second);
    assert!(before.contains("W11 ambient requirement"));
    assert!(before.contains("workspace memory") || before.contains("memory tool"));
    assert!(before.contains("W11 MCP requirement"));
    assert!(before.contains("Allowed MCP skill"));
    assert!(before.contains("<origin>table</origin>"));
    assert!(!before.contains("Hidden MCP skill"));
    let JsonValue::Object(first) = first else {
        panic!()
    };
    let advertised = stringify_json(first.get(&"tools".into()).unwrap());
    for name in ["read", "skill", "execute"] {
        assert!(
            advertised.contains(&format!("\"name\":\"{name}\"")),
            "missing advertised tool {name}"
        );
    }
    assert!(
        after.contains("Real file result"),
        "the next provider request must contain the real tool result"
    );
    assert!(after.contains("Previously loaded instructions no longer apply."));
    assert!(after.contains("MCP server instructions are no longer available."));
    assert!(after.contains("Skill guidance is no longer available."));
    assert!(after.contains("Instructions from ycoding/workspace-memory no longer apply."));
    assert!(helper.contains("Draft verification"));
    assert!(helper.contains("Instructions from ycoding/workspace-memory no longer apply."));
    let tools = match &second {
        JsonValue::Object(value) => stringify_json(value.get(&"tools".into()).unwrap()),
        _ => panic!(),
    };
    for name in ["read", "memory", "project_artifact", "skill", "execute"] {
        assert!(
            !tools.contains(&format!("\"name\":\"{name}\"")),
            "disabled tool {name}"
        );
    }
    let state = f
        .store
        .snapshot()
        .unwrap()
        .get::<InstructionStateTable>(&tuple_key(&[KeyPart::String(&"ses_one".into())]))
        .unwrap()
        .unwrap()
        .current_values
        .domain()
        .unwrap();
    for key in [
        "core/instructions",
        "core/date",
        "core/memory",
        "ycoding/workspace-memory",
        "core/project-artifact-authoring",
        "ycoding/project-artifact-authoring",
        "core/skill-guidance",
        "core/mcp-guidance",
    ] {
        assert!(state.0.get(&key.into()).is_none(), "stale key: {key}");
    }
    let current = f.services(&locations);
    assert!(
        Arc::ptr_eq(&mcp, &current.production.as_ref().unwrap().mcp),
        "unrelated reload must preserve the MCP manager"
    );
    std::fs::write(
        f.directory().join("ycoding.json"),
        configured(&initial_capabilities),
    )
    .unwrap();
    locations.reload(&current.info).unwrap();
    admit(&f, "ses_one", "reenable").await;
    Coordinator::new(Arc::new(
        f.services(&locations)
            .production
            .as_ref()
            .unwrap()
            .runner
            .clone(),
    ))
    .run(&session::Id::new("ses_one").unwrap())
    .await
    .unwrap();
    let reenabled = stringify_json(&requests.recv().await.unwrap());
    assert!(reenabled.contains("W11 ambient requirement"));
    assert!(reenabled.contains("\"name\":\"read\""));
    assert_eq!(
        std::fs::read_to_string(table.with_extension("log"))
            .unwrap()
            .lines()
            .filter(|line| line.contains("\"method\": \"initialize\""))
            .count(),
        1,
        "policy reload must not restart MCP"
    );
    drop(current);
    drop(services);
    drop(mcp);
    drop(_hook);
    locations.close().unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}
