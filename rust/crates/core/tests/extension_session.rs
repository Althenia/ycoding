include!("tool_fixture.rs");
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use ycoding_core::extension::{
    Configuration, Extension, FamilyGrant, Host, Options, SessionHost, ToolGrant, v5,
};
use ycoding_core::session::{
    execution::{Execution, Locations, Runner},
    run_coordinator::Error,
    store::Service,
};
use ycoding_schema::{location, parse_json, session, stringify_json};

#[path = "session_support/mod.rs"]
mod support;

struct NoPlacement;
impl Locations for NoPlacement {
    fn get(&self, _: &location::Ref) -> Result<Arc<dyn Runner>, Error> {
        Err(Error::Closed)
    }
}

async fn request(
    fixture: &ToolFixture,
    scopes: &[&str],
    host: Host,
    input: Value,
) -> ycoding_core::tools::materialization::Settlement {
    let registry = fixture.registry();
    let mut configuration = configuration(fixture, scopes);
    configuration.args[1] = "session_request".into();
    let extension = Extension::start(
        configuration,
        Options {
            startup: Duration::from_secs(2),
            execution: Duration::from_secs(10),
            ..Options::default()
        },
        &registry,
        fixture.policy.clone(),
        &ycoding_core::extension::Launch::default(),
        host,
    )
    .await
    .unwrap();
    let result = registry
        .materialize(&[])
        .invoke(
            "demo_echo",
            parse_json(&input.to_string()).unwrap(),
            fixture.context(),
        )
        .await
        .unwrap();
    extension.shutdown().await;
    result
}

fn value(settlement: ycoding_core::tools::materialization::Settlement) -> Value {
    assert!(settlement.error.is_none(), "{:?}", settlement.error);
    serde_json::from_str(&stringify_json(&settlement.output.unwrap().structured)).unwrap()
}

async fn services(
    fixture: &ToolFixture,
    sessions: &Service,
    client: ycoding_store::Client,
    seen: Arc<std::sync::Mutex<Vec<Value>>>,
) -> (
    ycoding_core::extension::SessionServices,
    tokio::task::JoinHandle<()>,
) {
    use ycoding_core::{
        resources::{
            agent, attachment_store, catalog::Catalog, command, config, credential, model,
        },
        session::{generate, runner},
        tools::policy::helper,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(move |body: String| {
                let seen = seen.clone();
                async move {
                    seen.lock().unwrap().push(serde_json::from_str(&body).unwrap());
                    ([("content-type", "text/event-stream")], "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Generated text\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3}}\n\ndata: [DONE]\n\n")
                }
            }),
        );
        axum::serve(listener, app).await.unwrap();
    });
    let mut catalog = Catalog::default();
    catalog.configure(&[parse_json(&serde_json::json!({"providers":{"fixture":{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{"apiKey":"fixture-key","baseURL":url},"models":{"code":{"name":"Code","capabilities":{"input":["text"],"output":["text"]}}}}}}).to_string()).unwrap()]).unwrap();
    let models = Arc::new(model::Resolver::new(catalog));
    let credentials = credential::Service::new(client.clone());
    let agents = Arc::new(agent::Service::new(vec![agent::empty("test".into())]));
    let executor = Arc::new(ycoding_ai::route::Executor::new(
        ycoding_ai::route::Executor::http_client().unwrap(),
    ));
    let attachments =
        Arc::new(attachment_store::Store::new(fixture.root.join("attachments")).unwrap());
    let location = sessions
        .get(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap()
        .location;
    let configuration = Arc::new(
        config::Configuration::load(config::LoadOptions {
            directory: fixture.root.clone(),
            roots: config::Roots::development(&fixture.root).unwrap(),
            project: false,
            file: None,
            content: Some("{}".into()),
            env: Default::default(),
        })
        .unwrap(),
    );
    let generation = Arc::new(generate::Service {
        store: sessions.clone(),
        location: location.clone(),
        agents: agents.clone(),
        models: Arc::new(helper::Models {
            models: models.clone(),
            credentials: credentials.clone(),
            auth: Default::default(),
            cursor: None,
            claude: None,
            store: sessions.clone(),
            settings: Default::default(),
        }),
        executor: executor.clone(),
        attachments: attachments.clone(),
        instructions: vec![],
        extensions: vec![],
    });
    let runner = runner::Local::new(runner::Services {
        snapshots: None,
        store: sessions.clone(),
        events: ycoding_core::event_feed::Feed::attach(&client),
        location,
        models,
        agents,
        credentials,
        tools: Arc::new(fixture.registry()),
        attachments,
        instructions: vec![],
        analysis: None,
        configuration: Some(configuration.clone()),
        image_analyzer: None,
        extensions: vec![],
        session_tools: None,
        clock: Arc::new(runner::WallClock),
        executor,
        compaction: Default::default(),
        guardrails: fixture.policy.guardrails.clone(),
        helpers: Default::default(),
        cursor: None,
        claude: None,
        auth: None,
        skill_resolver: None,
    });
    let mut commands = command::Service::default();
    commands.update("test".into(), |command| {
        command.template = "Run $ARGUMENTS".into()
    });
    (
        ycoding_core::extension::SessionServices {
            runner,
            generate: generation,
            commands: Arc::new(commands),
            configuration,
        },
        server,
    )
}

fn configuration(fixture: &ToolFixture, scopes: &[&str]) -> Configuration {
    Configuration {
        identity: "fixture".into(),
        executable: "/usr/bin/python3".into(),
        args: vec![
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/extension_child.py").into(),
            "session_ops".into(),
        ],
        directory: fixture.root.clone(),
        registration_order: 0,
        grants: vec![ToolGrant {
            namespace: "demo".into(),
            tools: vec!["echo".into()],
            action: "extension.echo".into(),
            resources: vec!["demo".into()],
        }],
        families: (!scopes.is_empty())
            .then(|| FamilyGrant {
                family: v5::CapabilityFamily::Session,
                scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
                action: "extension.session".into(),
                resources: vec!["sessions".into()],
            })
            .into_iter()
            .collect(),
    }
}
async fn summary(fixture: &ToolFixture, scopes: &[&str], host: Host) -> Value {
    let registry = fixture.registry();
    let extension = Extension::start(
        configuration(fixture, scopes),
        Options {
            startup: Duration::from_secs(1),
            execution: Duration::from_secs(10),
            cleanup: Duration::from_millis(100),
            shutdown: Duration::from_millis(100),
            write: Duration::from_millis(500),
        },
        &registry,
        fixture.policy.clone(),
        &ycoding_core::extension::Launch::default(),
        host,
    )
    .await
    .unwrap();
    let settlement = registry
        .materialize(&[])
        .invoke("demo_echo", parse_json("{}").unwrap(), fixture.context())
        .await
        .unwrap();
    assert!(settlement.error.is_none());
    extension.shutdown().await;
    serde_json::from_str(&stringify_json(&settlement.output.unwrap().structured)).unwrap()
}

#[tokio::test]
async fn session_calls_stay_inside_the_hosts_location_and_follow_durable_admission() {
    let store = support::store();
    let mut far = support::record("ses_far");
    far.directory = "/elsewhere".into();
    store
        .submit(move |tx| {
            ycoding_store::session::SessionTable::insert(tx, &far)?;
            let mut caller = support::record("ses_tool");
            caller.permission = Some(ycoding_store::session::Document::new(
                parse_json(r#"[{"action":"edit","resource":"*","effect":"deny"}]"#).unwrap(),
            )?);
            ycoding_store::session::SessionTable::insert(tx, &caller)?;
            let mut target = support::record("ses_one");
            target.agent = Some("test".into());
            target.model = Some(ycoding_store::session::Document::new(
                parse_json(r#"{"providerID":"fixture","id":"code"}"#).unwrap(),
            )?);
            target.permission = Some(ycoding_store::session::Document::new(
                parse_json(r#"[{"action":"network","resource":"*","effect":"deny"}]"#).unwrap(),
            )?);
            ycoding_store::session::SessionTable::put(tx, &target)
        })
        .unwrap()
        .wait()
        .unwrap();
    let sessions = Service::new(store.client());
    Execution::install(
        sessions.clone(),
        Arc::new(NoPlacement),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    let id = |value: &str| session::Id::new(value).unwrap();
    let fixture = ToolFixture::new();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (services, server) = services(&fixture, &sessions, store.client(), seen.clone()).await;
    let services = Arc::new(services);
    let host = || Host {
        sessions: Some(SessionHost {
            store: sessions.clone(),
            location: sessions.get(&id("ses_one")).unwrap().unwrap().location,
            services: Some(Arc::new({
                let services = services.clone();
                move || Ok(services.as_ref().clone())
            })),
        }),
        ..Host::default()
    };

    let all = summary(&fixture, &["get", "prompt", "interrupt"], host()).await;
    assert_eq!(all["get"]["value"]["title"], "Test");
    for rejected in ["foreign", "missing", "reuse", "far_prompt", "far_interrupt"] {
        assert_eq!(all[rejected]["failure"], 1, "{rejected}");
    }
    assert_eq!(all["prompt"]["value"]["id"], "msg_child");
    assert_eq!(
        all["retry"], all["prompt"],
        "the first admission wins on retry"
    );
    assert!(all["interrupt"]["value"].is_null());
    assert_eq!(sessions.pending_list(&id("ses_one")).unwrap().len(), 1);
    for other in ["ses_two", "ses_far"] {
        assert!(sessions.pending_list(&id(other)).unwrap().is_empty());
    }

    for operation in ["create", "command", "generate", "synthetic"] {
        let success = serde_json::json!({"op": operation, "session": if operation == "create" { "ses_created" } else { "ses_one" }, "message": format!("msg_{operation}")});
        let before = sessions.pending_list(&id("ses_one")).unwrap().len();
        assert_eq!(
            value(request(&fixture, &[], host(), success.clone()).await)["failure"],
            1,
            "{operation} requires its own grant"
        );
        let foreign = serde_json::json!({"op": operation, "session": "ses_far", "parent": "ses_far", "message": "msg_foreign"});
        assert_eq!(
            value(request(&fixture, &[operation], host(), foreign).await)["failure"],
            1,
            "{operation} rejects foreign placement"
        );
        assert_eq!(sessions.pending_list(&id("ses_one")).unwrap().len(), before);
        let denied = ToolFixture::new();
        denied.authority.session("ses_parent", None, 1, false, None);
        denied.authority.session(
            "ses_tool",
            Some("ses_parent"),
            1,
            false,
            Some(vec![ycoding_schema::permission::Rule {
                action: "extension.session".into(),
                resource: "*".into(),
                effect: ycoding_schema::permission::Effect("deny".into()),
            }]),
        );
        assert_eq!(
            value(request(&denied, &[operation], host(), success.clone()).await)["failure"],
            1,
            "{operation} cannot override the caller's inherited ceiling"
        );
        denied.cleanup();
        let mut placement = success.clone();
        placement["placement"] = true.into();
        assert!(
            request(&fixture, &[operation], host(), placement)
                .await
                .error
                .is_some(),
            "{operation} rejects child Location fields at the wire boundary"
        );
        let reply = value(request(&fixture, &[operation], host(), success.clone()).await);
        assert!(reply.get("failure").is_none(), "{operation}: {reply}");
        if operation == "create" {
            assert_eq!(reply["value"]["id"], "ses_created");
            assert_eq!(reply["value"]["location"]["directory"], "/project");
            assert_eq!(reply["value"]["permissionCeiling"][0]["effect"], "deny");
            assert_eq!(
                value(request(&fixture, &[operation], host(), success.clone()).await),
                reply
            );
        }
        if operation == "generate" {
            assert_eq!(reply["value"]["text"], "Generated text");
            assert_eq!(sessions.pending_list(&id("ses_one")).unwrap().len(), before);
            assert!(
                sessions
                    .latest(&id("ses_one"), "assistant")
                    .unwrap()
                    .is_none()
            );
        }
        if operation == "command" || operation == "synthetic" {
            assert_eq!(reply["value"]["id"], format!("msg_{operation}"));
            assert_eq!(
                value(request(&fixture, &[operation], host(), success).await),
                reply
            );
            assert_eq!(
                sessions.pending_list(&id("ses_one")).unwrap().len(),
                before + 1
            );
        }
    }
    let command = sessions
        .pending(&ycoding_schema::session_message::Id::new("msg_command").unwrap())
        .unwrap()
        .unwrap();
    let child = value(request(&fixture, &["create"], host(), serde_json::json!({
        "op":"create","session":"ses_created_child","parent":"ses_one",
        "ceiling":[{"action":"edit","resource":"*","effect":"allow"},{"action":"read","resource":"*","effect":"deny"}]
    })).await);
    assert_eq!(child["value"]["parentID"], "ses_one");
    assert_eq!(
        child["value"]["model"],
        serde_json::json!({"providerID":"fixture","id":"code"})
    );
    assert_eq!(
        child["value"]["permissionCeiling"],
        serde_json::json!([
            {"action":"edit","resource":"*","effect":"deny"},
            {"action":"network","resource":"*","effect":"deny"},
            {"action":"read","resource":"*","effect":"deny"}
        ])
    );
    let command_data: Value = serde_json::from_str(&stringify_json(&command.data)).unwrap();
    assert_eq!(command_data["text"], "Run value");
    let synthetic = sessions
        .pending(&ycoding_schema::session_message::Id::new("msg_synthetic").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(synthetic.type_.as_str(), Some("synthetic"));
    let synthetic_data: Value = serde_json::from_str(&stringify_json(&synthetic.data)).unwrap();
    assert_eq!(synthetic_data["description"], "Observed");
    {
        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .get("tools")
                .is_none_or(|tools| tools.as_array().is_some_and(Vec::is_empty))
        );
        assert!(
            requests[0]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["content"] == "Generate only")
        );
    }
    for input in [
        serde_json::json!({"op":"create","session":"ses_invalid","agent":"decision"}),
        serde_json::json!({"op":"create","session":"ses_invalid","parent":"ses_missing"}),
        serde_json::json!({"op":"create","session":"ses_invalid","parent":"ses_far"}),
        serde_json::json!({"op":"create","session":"ses_invalid","model":{"providerID":"fixture","id":"code","profile":"missing"}}),
        serde_json::json!({"op":"command","command":"missing"}),
        serde_json::json!({"op":"synthetic","message":"msg_child"}),
        serde_json::json!({"op":"synthetic","input":{"type":"user","data":{"text":"bad"},"delivery":"steer"}}),
        serde_json::json!({"op":"command","input":{"type":"synthetic","data":{"text":"bad"},"delivery":"steer"}}),
        serde_json::json!({"op":"command","input":{"type":"user","data":{"text":"bad","location":{"directory":"/elsewhere"}},"delivery":"steer"}}),
        serde_json::json!({"op":"synthetic","input":{"type":"synthetic","data":{"text":"bad"},"delivery":"steer","location":{"directory":"/elsewhere"}}}),
    ] {
        let operation = input["op"].as_str().unwrap();
        assert_eq!(
            value(request(&fixture, &[operation], host(), input.clone()).await)["failure"],
            1,
            "{input}"
        );
    }
    assert!(sessions.get(&id("ses_invalid")).unwrap().is_none());
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
    fixture.cleanup();

    let fixture = ToolFixture::new();
    let get_only = summary(&fixture, &["get"], host()).await;
    assert_eq!(get_only["get"]["value"]["title"], "Test");
    for rejected in ["prompt", "retry", "interrupt"] {
        assert_eq!(
            get_only[rejected]["failure"], 1,
            "{rejected} requires its own scope"
        );
    }
    fixture.cleanup();

    let fixture = ToolFixture::new();
    let hostless = summary(&fixture, &["get", "prompt", "interrupt"], Host::default()).await;
    for rejected in ["get", "prompt", "interrupt"] {
        assert_eq!(hostless[rejected]["failure"], 1, "{rejected}");
    }
    fixture.cleanup();
    drop(services);
    store.shutdown().unwrap();
}

#[test]
fn session_scopes_are_the_seven_explicit_operations() {
    let fixture = ToolFixture::new();
    for (scopes, valid) in [
        (&["get", "prompt", "interrupt"][..], true),
        (&["create", "generate", "command", "synthetic"][..], true),
        (&["session.create"][..], false),
        (&["/api/session"][..], false),
        (&["get", "get"][..], false),
    ] {
        assert_eq!(configuration(&fixture, scopes).validate().is_ok(), valid);
    }
    fixture.cleanup();
}
