mod support;

use prost::{Message, Name};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::mpsc, time::timeout};
use ycoding_core::{
    resources::{catalog::models_dev, config},
    session::{orchestration, pending::Request},
    ycoding_schema::{
        DomainDecode, JsonValue, event, parse_json, session, session_message, session_pending,
        stringify_json,
    },
    ycoding_store::{Metadata, Options, Store, session::SessionTable},
};
use ycoding_protocol::{connection::Budgets, decode_strict, v5};
use ycoding_runtime::{
    Core, Environment, Identity, LocalAuth, Production, Services, Settled, Subscriptions,
    connector::{Credential, Enrolled, Peer},
    standard,
};

const REPLY: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Side answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";

struct Quiet;
impl orchestration::Execution for Quiet {
    fn wake(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::Outcome {
        Ok(())
    }
    fn interrupt(&self, _: &session::Id) -> ycoding_core::session::run_coordinator::RunFuture {
        Box::pin(async { Ok(()) })
    }
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

// The side-chat operations are remote-derived, so they cross the same dispatcher
// entry the connector uses for an authenticated remote peer.
async fn remote<Q: Message, R: Message + Name + Default>(
    environment: &Arc<Environment>,
    name: &str,
    scope: v5::Scope,
    query: Q,
) -> R {
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "flow-test".into(),
            now() + 60_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap();
    let settled = standard()
        .unwrap()
        .invoke_remote(
            environment.clone(),
            "flow-connection".into(),
            &peer,
            v5::Request {
                request_id: "flow-request".into(),
                operation_id: support::operation(name).operation_id,
                scope,
                payload: query.encode_to_vec(),
            },
        )
        .await;
    let Some(Settled::Result(result)) = settled else {
        panic!("missing inline settlement for {name}")
    };
    let Some(v5::result::Outcome::Success(payload)) = result.outcome else {
        panic!("{name} was rejected")
    };
    assert_eq!(payload.type_name, R::full_name());
    decode_strict(&payload.payload).unwrap()
}

fn input(session: &str, id: &str, text: &str) -> Request {
    Request {
        id: session_message::Id::new(id).unwrap(),
        session_id: session::Id::new(session).unwrap(),
        input: session_pending::Message::decode(
            &parse_json(&format!(
                r#"{{"type":"user","data":{{"text":{}}},"delivery":"steer"}}"#,
                stringify_json(&JsonValue::String(text.into()))
            ))
            .unwrap(),
        )
        .unwrap(),
        event_id: event::Id::new(format!("evt_{id}")).unwrap(),
        created: 10,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn side_chat_keeps_its_own_identity_and_is_promptable_beside_the_unchanged_parent() {
    timeout(Duration::from_secs(90), flow()).await.unwrap();
}

async fn flow() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (requests, mut received) = mpsc::unbounded_channel();
    let router = axum::Router::new().route(
        "/chat/completions",
        axum::routing::post(move |body: axum::body::Bytes| {
            let requests = requests.clone();
            async move {
                requests
                    .send(String::from_utf8(body.to_vec()).unwrap())
                    .unwrap();
                axum::http::Response::builder()
                    .status(200)
                    .header("content-type", "text/event-stream")
                    .body(axum::body::Body::from(REPLY))
                    .unwrap()
            }
        }),
    );
    let (stop_provider, stopped_provider) = tokio::sync::watch::channel(false);
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
        "session-flow-runtime-{}-{}",
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
    std::fs::write(
        roots.config.join("ycoding.json"),
        format!(
            r#"{{"model":{{"providerID":"openai","model":"session-model"}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}}}}"#
        ),
    )
    .unwrap();
    let catalog = roots.cache.join("models.json");
    std::fs::write(&catalog, r#"{"openai":{"id":"openai","name":"Fixture","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"session-model":{"id":"session-model","name":"Session","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192},"cost":{"input":1,"output":2}}}}}"#).unwrap();
    let store = Store::initialize(
        root.join("store.redb"),
        Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
        Metadata::new([5; 16], 1),
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
            let mut row = support::record("ses_parent");
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
    let environment = Arc::new(Environment {
        services: Services {
            identity: Identity {
                version: "flow".into(),
                pid: std::process::id() as u64,
                source_epoch: "flow-source".into(),
            },
            auth: LocalAuth::disabled(),
            cors: vec![],
            budgets: Budgets::default(),
            core: Some(core.clone()),
        },
        urls: vec![],
        subscriptions: Subscriptions::default(),
        uploads: Default::default(),
    });
    let parent = session::Id::new("ses_parent").unwrap();
    let side = session::Id::new("ses_parent_btw").unwrap();

    // The parent carries visible history; admitting it never starts the provider.
    core.execution
        .prompt(
            input("ses_parent", "msg_parent_task", "Parent task"),
            Some(false),
        )
        .await
        .unwrap();
    core.sessions.promote_steers(&parent, 11).await.unwrap();
    let parent_history = core.sessions.context(&parent).unwrap();
    assert_eq!(parent_history.len(), 1);
    assert!(received.try_recv().is_err());

    let create = || v5::SessionSideChatCreateRequest {
        payload: v5::SessionSideChatCreateRequestPayload {
            id: support::text("ses_parent_btw"),
        },
    };
    let created: v5::SessionSideChatCreateResult = remote(
        &environment,
        "session.side-chat.create",
        support::session_scope("ses_parent"),
        create(),
    )
    .await;
    assert_eq!(support::units(&created.data.id), "ses_parent_btw");
    let info = core.sessions.get(&side).unwrap().unwrap();
    assert_eq!(info.parent_id.as_ref(), Some(&parent));
    assert_eq!(
        info.agent.as_ref().and_then(|agent| agent.as_str()),
        Some("btw")
    );
    assert_eq!(
        info.location,
        core.sessions.get(&parent).unwrap().unwrap().location
    );
    let context = core.sessions.pending_list(&side).unwrap();
    assert_eq!(context.len(), 1, "the parent snapshot is admitted once");
    assert!(stringify_json(&context[0].data).contains("Parent task"));
    assert!(!core.execution.active().contains(&side));
    assert!(received.try_recv().is_err(), "creation sends nothing");

    // Re-creating the same identity returns it without a second context admission.
    let again: v5::SessionSideChatCreateResult = remote(
        &environment,
        "session.side-chat.create",
        support::session_scope("ses_parent"),
        create(),
    )
    .await;
    assert_eq!(again.data.id, created.data.id);
    assert_eq!(core.sessions.pending_list(&side).unwrap().len(), 1);

    // Listing returns the side chat, which is not a Team task of the parent.
    let listed: v5::SessionSideChatListResult = remote(
        &environment,
        "session.side-chat.list",
        support::session_scope("ses_parent"),
        v5::SessionSideChatListRequest {
            payload: v5::SessionSideChatListRequestPayload { cursor: None },
        },
    )
    .await;
    assert_eq!(
        listed
            .data
            .items
            .iter()
            .map(|item| support::units(&item.id))
            .collect::<Vec<_>>(),
        ["ses_parent_btw"]
    );
    let team = orchestration::Service::new(core.sessions.clone(), Arc::new(Quiet))
        .page(&parent, None, None)
        .unwrap();
    assert_eq!(team.summary.total.get(), 0);

    // The side chat is promptable on its own; the provider sees the parent snapshot and
    // the new prompt, and the parent history stays exactly as it was.
    core.execution
        .prompt(
            input("ses_parent_btw", "msg_side_prompt", "Side question"),
            None,
        )
        .await
        .unwrap();
    let body = timeout(Duration::from_secs(30), received.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        body.contains("\"name\":\"read\""),
        "probe needs the tool list: {body}"
    );
    assert!(
        body.contains("\"name\":\"skill\""),
        "model-callable skill tool is not advertised"
    );
    assert!(body.contains("Recent parent session history"), "{body}");
    assert!(body.contains("Parent task") && body.contains("Side question"));
    timeout(Duration::from_secs(30), core.execution.await_idle(&side))
        .await
        .unwrap();
    assert_eq!(core.sessions.context(&parent).unwrap(), parent_history);
    assert!(core.sessions.pending_list(&parent).unwrap().is_empty());
    assert!(
        core.sessions
            .context(&side)
            .unwrap()
            .iter()
            .any(|message| matches!(message, session_message::Info::User(user) if user.text.to_utf8().unwrap() == "Side question"))
    );

    core.shutdown().await.unwrap();
    stop_provider.send(true).unwrap();
    provider.await.unwrap();
    store.shutdown().unwrap();
}
