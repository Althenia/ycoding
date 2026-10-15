use super::*;
use ycoding_core::{
    session::{pending, run_coordinator::Coordinator},
    ycoding_schema::{event, session_pending, stringify_json},
    ycoding_store::{KeyPart, session::InstructionStateTable, tuple_key},
};

const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Finished\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_runner_titles_only_the_first_promoted_prompt_and_uses_reference_guidance() {
    let (endpoint, mut requests, stop, server) = provider(vec![TEXT.into(), TEXT.into()]).await;
    let f = fixture("{}", &policy(&endpoint, "{}"));
    std::fs::write(f.directory().join("ycoding.json"), format!(r#"{{"model":{{"providerID":"openai","model":"gpt-runtime"}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}},"references":{{"manual":{{"path":".","description":"Production reference requirement"}}}}}}"#)).unwrap();
    let locations = f.locations();
    let held = f.services(&locations);
    admit(&f, "ses_one", "first_title").await;
    Coordinator::new(Arc::new(held.production.as_ref().unwrap().runner.clone()))
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert_eq!(
        f.sessions()
            .get(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .unwrap()
            .title
            .as_str(),
        Some("Run the requested check")
    );
    assert!(
        stringify_json(&requests.recv().await.unwrap())
            .contains("Production reference requirement")
    );
    locations.reload(&held.info).unwrap();
    admit(&f, "ses_one", "second_title").await;
    let fresh = f.services(&locations);
    Coordinator::new(Arc::new(fresh.production.as_ref().unwrap().runner.clone()))
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let renamed = f
        .store
        .client()
        .snapshot()
        .unwrap()
        .scan::<ycoding_core::ycoding_store::session::EventTable>(
            std::ops::Bound::Unbounded,
            std::ops::Bound::Unbounded,
            100,
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.type_.as_str() == Some("session.renamed.1"))
        .count();
    assert_eq!(
        renamed, 1,
        "reload and subsequent prompts must not rename twice"
    );
    requests.recv().await.unwrap();
    assert!(
        requests.try_recv().is_err(),
        "local titles must not call a provider"
    );
    locations.close().unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wellknown_sources_rebuild_with_the_latest_saved_key_and_explicit_refresh_resolves_unchanged_manifests()
 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let manifest = format!(
        r#"{{"auth":{{"command":["fixture-login"],"env":"TOKEN"}},"config":{{"agents":{{"god":{{"description":"embedded"}}}}}},"remote_config":{{"url":"{endpoint}/configuration","headers":{{"authorization":"Bearer {{env:TOKEN}}"}}}}}}"#
    );
    let revision = Arc::new(std::sync::atomic::AtomicU16::new(1));
    let current = revision.clone();
    let (send, mut keys) = mpsc::unbounded_channel();
    let router = axum::Router::new()
        .route("/.well-known/ycoding", axum::routing::get(move || { let manifest = manifest.clone(); async move { manifest } }))
        .route("/configuration", axum::routing::get(move |headers: axum::http::HeaderMap| {
            send.send(headers.get("authorization").unwrap().to_str().unwrap().to_owned()).unwrap();
            let revision = current.load(std::sync::atomic::Ordering::Acquire);
            async move {
                (axum::http::StatusCode::from_u16(if revision == 500 { 500 } else { 200 }).unwrap(), format!(r#"{{"username":"remote-{revision}","agents":{{"god":{{"description":"remote"}}}}}}"#))
            }
        }));
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let mut f = fixture(
        "{}",
        r#"{"username":"project","agents":{"god":{"description":"project"}}}"#,
    );
    Arc::get_mut(&mut f.factory).unwrap().options.content =
        Some(r#"{"agents":{"god":{"description":"inline"}}}"#.into());
    f.factory.globals.wellknown.add(&endpoint, 1).await.unwrap();
    let locations = f.locations();
    let first = f.services(&locations);
    assert_eq!(
        first
            .production
            .as_ref()
            .unwrap()
            .configuration
            .latest("username"),
        Some(&JsonValue::String("project".into()))
    );
    assert!(
        keys.try_recv().is_err(),
        "an unauthenticated source cannot resolve configuration"
    );
    let key = |key: &str| {
        Secret::new(
            ycoding_core::ycoding_schema::credential::Value::Key(
                ycoding_core::ycoding_schema::credential::Key {
                    key: key.into(),
                    metadata: None,
                },
            )
            .encode(),
        )
        .unwrap()
    };
    f.factory
        .credentials
        .create(
            "wk_first".into(),
            endpoint.as_str().into(),
            Some("First".into()),
            key("first"),
            2,
        )
        .await
        .unwrap();
    locations.credentials_changed().await.unwrap();
    let second = f.services(&locations);
    assert_eq!(
        second
            .production
            .as_ref()
            .unwrap()
            .configuration
            .latest("username"),
        Some(&JsonValue::String("remote-1".into()))
    );
    assert_eq!(description(&second).as_deref(), Some("inline"));
    assert_eq!(keys.recv().await.unwrap(), "Bearer first");
    f.factory
        .credentials
        .create(
            "wk_second".into(),
            endpoint.as_str().into(),
            Some("Second".into()),
            key("second"),
            3,
        )
        .await
        .unwrap();
    f.factory
        .credentials
        .activate("wk_first".into(), 4)
        .await
        .unwrap();
    locations.credentials_changed().await.unwrap();
    assert_eq!(
        keys.recv().await.unwrap(),
        "Bearer second",
        "configuration selects the latest saved key, not the active profile"
    );
    revision.store(2, std::sync::atomic::Ordering::Release);
    assert!(!f.factory.globals.wellknown.refresh().await.unwrap());
    locations.reload(&first.info).unwrap();
    let refreshed = f.services(&locations);
    assert_eq!(
        refreshed
            .production
            .as_ref()
            .unwrap()
            .configuration
            .latest("username"),
        Some(&JsonValue::String("remote-2".into()))
    );
    assert_eq!(
        first
            .production
            .as_ref()
            .unwrap()
            .configuration
            .latest("username"),
        Some(&JsonValue::String("project".into())),
        "held configuration remains immutable"
    );
    revision.store(500, std::sync::atomic::Ordering::Release);
    assert!(locations.reload(&first.info).is_err());
    assert_eq!(
        f.services(&locations)
            .production
            .as_ref()
            .unwrap()
            .generation,
        refreshed.production.as_ref().unwrap().generation
    );
    revision.store(2, std::sync::atomic::Ordering::Release);
    let notify = Arc::new(tokio::sync::Notify::new());
    let wake = notify.clone();
    let updates = f
        .feed
        .subscribe_types(
            ycoding_core::event_feed::Scope::Global,
            &["config.updated"],
            move || wake.notify_one(),
        )
        .unwrap();
    f.factory
        .globals
        .wellknown
        .remove(&endpoint, 5)
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if f.services(&locations)
                .production
                .as_ref()
                .unwrap()
                .configuration
                .latest("username")
                == Some(&JsonValue::String("project".into()))
            {
                break;
            }
            notify.notified().await;
            while updates.next().unwrap().is_some() {}
        }
    })
    .await
    .unwrap();
    locations.close().unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_reference_acquisition_is_cached_and_only_explicit_refresh_fetches_the_remote_branch()
 {
    let remote = filesystem_fixture::Fixture::new();
    remote.repository();
    remote.git(&["init", "--bare", "origin.git"]);
    remote.write("README.md", "one");
    remote.git(&["add", "README.md"]);
    remote.git(&["commit", "-m", "one"]);
    let local = url::Url::from_file_path(remote.0.join("origin.git"))
        .unwrap()
        .to_string();
    remote.git(&["remote", "add", "origin", &local]);
    remote.git(&["push", "-u", "origin", "main"]);
    remote.git(&["--git-dir", "origin.git", "update-server-info"]);
    remote.git(&[
        "--git-dir",
        "origin.git",
        "symbolic-ref",
        "HEAD",
        "refs/heads/main",
    ]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}/repo.git", listener.local_addr().unwrap());
    let bare = remote.0.join("origin.git");
    let router = axum::Router::new().route(
        "/repo.git/{*path}",
        axum::routing::get(
            move |axum::extract::Path(path): axum::extract::Path<String>| {
                let bare = bare.clone();
                async move {
                    if path.split('/').any(|part| part == "..") {
                        return axum::http::Response::builder()
                            .status(400)
                            .body(axum::body::Body::empty())
                            .unwrap();
                    }
                    match tokio::fs::read(bare.join(path)).await {
                        Ok(bytes) => axum::http::Response::new(axum::body::Body::from(bytes)),
                        Err(_) => axum::http::Response::builder()
                            .status(404)
                            .body(axum::body::Body::empty())
                            .unwrap(),
                    }
                }
            },
        ),
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
    let f = fixture(
        "{}",
        &format!(r#"{{"references":{{"lib":{{"repository":"{origin}","branch":"main"}}}}}}"#),
    );
    let target = ycoding_core::platform::repository_cache::parse_remote(&origin, None)
        .unwrap()
        .cache_path(&f.roots.repos);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    remote.git(&["clone", &local, target.to_str().unwrap()]);
    filesystem_fixture::git(&target, &["config", "remote.origin.url", &origin]);
    let locations = f.locations();
    let first = f.services(&locations);
    assert_eq!(
        std::fs::read_to_string(target.join("README.md")).unwrap(),
        "one"
    );
    remote.write("README.md", "two");
    remote.git(&["add", "README.md"]);
    remote.git(&["commit", "-m", "two"]);
    remote.git(&["push"]);
    remote.git(&["--git-dir", "origin.git", "update-server-info"]);
    locations
        .reload_generation(&first.info, first.production.as_ref().unwrap().generation)
        .unwrap();
    let cached = f.services(&locations);
    assert!(!Arc::ptr_eq(
        &first.production.as_ref().unwrap().references,
        &cached.production.as_ref().unwrap().references
    ));
    assert_eq!(
        std::fs::read_to_string(target.join("README.md")).unwrap(),
        "one",
        "ordinary rebuilds must not fetch or reset a reference"
    );
    locations.reload(&first.info).unwrap();
    let fetched = f.services(&locations);
    assert_eq!(
        std::fs::read_to_string(target.join("README.md")).unwrap(),
        "two"
    );
    stop.send(()).unwrap();
    server.await.unwrap();
    assert!(locations.reload(&first.info).is_err());
    assert_eq!(
        f.services(&locations)
            .production
            .as_ref()
            .unwrap()
            .generation,
        fetched.production.as_ref().unwrap().generation,
        "failed explicit fetch keeps the published reference generation"
    );
    locations.close().unwrap();
}

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
