use std::sync::Arc;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        run_coordinator::Coordinator,
        runner::{Local, Services, WallClock},
        store::Service,
    },
    tools::registry::Registry,
};
use ycoding_schema::{DomainDecode, parse_json, session, session_message, session_pending};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
mod support;

async fn server(
    replies: Vec<&'static str>,
) -> (
    String,
    mpsc::UnboundedReceiver<ycoding_schema::JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    server_status(replies.into_iter().map(|reply| (200, reply)).collect()).await
}

async fn server_status(
    replies: Vec<(u16, &'static str)>,
) -> (
    String,
    mpsc::UnboundedReceiver<ycoding_schema::JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    server_headers(
        replies
            .into_iter()
            .map(|(status, reply)| (status, "", reply))
            .collect(),
    )
    .await
}

async fn server_headers(
    replies: Vec<(u16, &'static str, &'static str)>,
) -> (
    String,
    mpsc::UnboundedReceiver<ycoding_schema::JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for (status, extra, reply) in replies {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let boundary = loop {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
                if let Some(boundary) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    break boundary + 4;
                }
            };
            let header = std::str::from_utf8(&request[..boundary]).unwrap();
            let length = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let mut body =
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap();
            if let ycoding_schema::JsonValue::Object(body) = &mut body {
                body.insert(
                    "_testAuthorization".into(),
                    ycoding_schema::JsonValue::String(
                        std::str::from_utf8(&request[..boundary])
                            .unwrap()
                            .lines()
                            .find_map(|line| {
                                line.split_once(':')
                                    .filter(|(key, _)| key.eq_ignore_ascii_case("authorization"))
                                    .map(|(_, value)| value.trim())
                            })
                            .unwrap_or("")
                            .into(),
                    ),
                );
            }
            send.send(body).unwrap();
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: {}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{reply}",
                if status == 200 {
                    "text/event-stream"
                } else {
                    "application/json"
                },
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, receive, task)
}

fn local(store: &ycoding_store::Store, endpoint: &str, registry: Arc<Registry>) -> Local {
    local_clock(store, endpoint, registry, Arc::new(WallClock))
}

fn local_clock(
    store: &ycoding_store::Store,
    endpoint: &str,
    registry: Arc<Registry>,
    clock: Arc<dyn ycoding_core::session::runner::Clock>,
) -> Local {
    local_sources(store, endpoint, registry, clock, Vec::new())
}

fn local_sources(
    store: &ycoding_store::Store,
    endpoint: &str,
    registry: Arc<Registry>,
    clock: Arc<dyn ycoding_core::session::runner::Clock>,
    instructions: Vec<ycoding_core::instructions::Source>,
) -> Local {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    local_services(
        store,
        catalog,
        vec![agent::empty("build".into())],
        registry,
        clock,
        instructions,
    )
}

fn local_services(
    store: &ycoding_store::Store,
    catalog: Catalog,
    agents: Vec<ycoding_schema::agent::Info>,
    registry: Arc<Registry>,
    clock: Arc<dyn ycoding_core::session::runner::Clock>,
    instructions: Vec<ycoding_core::instructions::Source>,
) -> Local {
    local_hosted(store, catalog, agents, registry, clock, instructions, None)
}

fn local_hosted(
    store: &ycoding_store::Store,
    catalog: Catalog,
    agents: Vec<ycoding_schema::agent::Info>,
    registry: Arc<Registry>,
    clock: Arc<dyn ycoding_core::session::runner::Clock>,
    instructions: Vec<ycoding_core::instructions::Source>,
    cursor: Option<ycoding_core::resources::cursor::route::Host>,
) -> Local {
    Local::new(Services {
        store: Service::new(store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(agents)),
        credentials: credential::Service::new(store.client()),
        tools: registry,
        attachments: Arc::new(
            attachment_store::Store::new(std::env::temp_dir().join("ycoding-runner-attachments"))
                .unwrap(),
        ),
        instructions,
        analysis: None,
        clock,
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor,
    })
}

#[tokio::test]
async fn composed_builtin_file_and_entry_sources_render_updates_and_removal_from_admitted_values() {
    let root = std::env::temp_dir().join(format!(
        "ycoding-instructions-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("AGENTS.md"), "Ambient file requirement").unwrap();
    let store = support::store();
    let service = Service::new(store.client());
    let id = session::Id::new("ses_one").unwrap();
    let entry = ycoding_schema::instruction_entry::Info::decode(
        &parse_json(r#"{"key":"task-context","value":"Original context"}"#).unwrap(),
    )
    .unwrap();
    service
        .put_instruction_entry(&id, entry.clone(), 1)
        .await
        .unwrap();
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT, TEXT]).await;
    let mut sources = ycoding_core::instructions::builtins::load(
        ycoding_core::instructions::builtins::Environment {
            directory: "/project".into(),
            project_root: "/project".into(),
            git: true,
            platform: "darwin".into(),
        },
        Arc::new(|| 1791763200000),
    );
    sources.push(ycoding_core::session::instruction_sources::ambient(
        ycoding_core::resources::instruction_discovery::Options {
            directory: root.clone(),
            project_root: root.clone(),
            global_config: root.join("global"),
            project: true,
            max_bytes: None,
        },
    ));
    let coordinator = Coordinator::new(Arc::new(local_sources(
        &store,
        &endpoint,
        registry(),
        Arc::new(WallClock),
        sources,
    )));
    coordinator.run(&id).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(first.contains("Working directory: /project"));
    assert!(first.contains("Today's date:"));
    assert!(first.contains("Before launching a subagent"));
    assert!(first.contains("Ambient file requirement"));
    assert!(first.contains("Original context"));
    service
        .put_instruction_entry(
            &id,
            ycoding_schema::instruction_entry::Info::decode(
                &parse_json(r#"{"key":"task-context","value":"Changed context"}"#).unwrap(),
            )
            .unwrap(),
            2,
        )
        .await
        .unwrap();
    std::fs::write(root.join("AGENTS.md"), "Updated ambient requirement").unwrap();
    coordinator.run(&id).await.unwrap();
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(second.contains("changed and supersedes the previous value"));
    assert!(second.contains("Changed context"));
    assert!(
        second.contains("These instructions replace all previously loaded ambient instructions")
    );
    assert!(second.contains("Updated ambient requirement"));
    service
        .remove_instruction_entry(&id, &entry.key, 3)
        .await
        .unwrap();
    coordinator.run(&id).await.unwrap();
    let third = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(third.contains("no longer applies. Disregard it."));
    assert!(service.instruction_entries(&id).unwrap().is_empty());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

struct ImmediateClock(Arc<std::sync::Mutex<Vec<u64>>>);
impl ycoding_core::session::runner::Clock for ImmediateClock {
    fn now(&self) -> i64 {
        10
    }
    fn sleep(
        &self,
        milliseconds: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        self.0.lock().unwrap().push(milliseconds);
        Box::pin(async {})
    }
}

#[tokio::test]
async fn rate_limit_retries_one_logical_step_with_a_second_physical_request() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server_status(vec![
        (429, r#"{"error":{"message":"rate limited"}}"#),
        (200, TEXT),
    ])
    .await;
    let delays = Arc::new(std::sync::Mutex::new(Vec::new()));
    let coordinator = Coordinator::new(Arc::new(local_clock(
        &store,
        &endpoint,
        registry(),
        Arc::new(ImmediateClock(delays.clone())),
    )));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert_eq!(*delays.lock().unwrap(), vec![2000]);
    requests.recv().await.unwrap();
    requests.recv().await.unwrap();
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|message| matches!(
                message,
                ycoding_schema::session_message::Info::Assistant(_)
            ))
            .count(),
        1
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

fn registry() -> Arc<Registry> {
    Arc::new(Registry::new(
        Arc::new(ycoding_core::resources::tool_output_store::Store::new(
            &ycoding_core::resources::config::Roots::development(
                &std::env::temp_dir().join("ycoding-runner-output"),
            )
            .unwrap(),
        )),
        None,
        Default::default(),
        Arc::new(|left, right| left.cmp(right)),
    ))
}

async fn admit(service: &Service) {
    admit_input(service, "input", "Answer the prompt", "steer").await;
}

async fn admit_input(service: &Service, name: &str, text: &str, delivery: &str) {
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new(format!("msg_{name}")).unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":"{text}"}},"delivery":"{delivery}"}}"#
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new(format!("evt_{name}")).unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

fn last_assistant(service: &Service) -> ycoding_schema::session_message::Assistant {
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let ycoding_schema::session_message::Info::Assistant(assistant) = history.last().unwrap()
    else {
        panic!()
    };
    (**assistant).clone()
}

fn event_types(store: &ycoding_store::Store) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|event| event.record.type_.as_str().unwrap().to_string())
        .collect()
}

const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const EMPTY: &str = "data: {\"id\":\"empty\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
const TOOL: &str = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_fixture\",\"type\":\"function\",\"function\":{\"name\":\"echo\",\"arguments\":\"{\\\"value\\\":\\\"observed\\\"}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";

#[tokio::test]
async fn actual_location_runner_streams_one_physical_request_and_projects_a_terminal_assistant() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let request = requests.recv().await.unwrap();
    assert!(ycoding_schema::stringify_json(&request).contains("Answer the prompt"));
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let ycoding_schema::session_message::Info::Assistant(assistant) = history.last().unwrap()
    else {
        panic!()
    };
    assert!(assistant.time.completed.is_some());
    let ycoding_schema::session_message::AssistantContent::Text(text) = &assistant.content[0]
    else {
        panic!()
    };
    assert_eq!(text.text.as_str(), Some("Answer"));
    assert_eq!(assistant.tokens.as_ref().unwrap().output.get(), 2.0);
    assert!(
        service
            .pending_list(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .is_empty()
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn session_instruction_entries_are_admitted_before_promotion_and_rendered_in_the_first_request()
 {
    let store = support::store();
    let service = Service::new(store.client());
    store
        .submit(|tx| {
            ycoding_store::session::InstructionEntryTable::insert(
                tx,
                &ycoding_store::session::InstructionEntry {
                    session_id: "ses_one".into(),
                    key: "task-context".into(),
                    value: Some(ycoding_store::session::Document::new(
                        parse_json(r#"{"requirement":"Use the durable task context"}"#).unwrap(),
                    )?),
                    removed: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let request = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(request.contains("<context key=\\\"task-context\\\">"));
    assert!(request.contains("Use the durable task context"));
    let snapshot = store.snapshot().unwrap();
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    let events = snapshot
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 100,
            },
        )
        .unwrap();
    let instructions = events
        .iter()
        .find(|event| event.record.type_.as_str() == Some("session.instructions.updated.2"))
        .unwrap();
    assert!(ycoding_schema::stringify_json(&instructions.record.data).contains("api/task-context"));
    assert!(
        !ycoding_schema::stringify_json(&instructions.record.data)
            .contains("Use the durable task context")
    );
    assert!(
        instructions.record.seq
            < events
                .iter()
                .find(|event| event.record.type_.as_str() == Some("session.input.promoted.1"))
                .unwrap()
                .record
                .seq
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn named_profile_pins_the_selected_account_and_rejects_replacement_before_another_request() {
    let store = support::store();
    let service = Service::new(store.client());
    let credentials = credential::Service::new(store.client());
    let key = |value: &str| {
        ycoding_store::resources::Secret::new(
            ycoding_schema::ObjectEncoder::new()
                .field("type", "key")
                .field("key", value)
                .finish(),
        )
        .unwrap()
    };
    let selected = credentials
        .create(
            "cred_work".into(),
            "openai".into(),
            Some("Work".into()),
            key("fixture-work-key"),
            1,
        )
        .await
        .unwrap();
    credentials
        .create(
            "cred_personal".into(),
            "openai".into(),
            Some("Personal".into()),
            key("fixture-personal-key"),
            2,
        )
        .await
        .unwrap();
    store
        .submit(|tx| {
            let mut row = tx
                .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"ses_one".into()),
                ]))?
                .unwrap();
            row.model = Some(ycoding_store::session::Document::new(
                parse_json(r#"{"providerID":"openai","id":"gpt-reasoning","profile":"Work"}"#)
                    .unwrap(),
            )?);
            ycoding_store::session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let request = requests.recv().await.unwrap();
    let ycoding_schema::JsonValue::Object(request) = request else {
        panic!()
    };
    assert_eq!(
        request.get(&"_testAuthorization".into()),
        Some(&ycoding_schema::JsonValue::String(
            "Bearer fixture-work-key".into()
        ))
    );
    let row = store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap();
    let binding = row.profile_binding.unwrap().domain().unwrap();
    assert_eq!(binding.credential_id.0, *selected.id());
    assert_eq!(
        provider_requests(&store)[0]
            .connection_identity_digest
            .as_ref()
            .and_then(|digest| digest.as_str()),
        Some(
            ycoding_core::session::prompt_cache::sha256(&format!(
                r#"{{"integrationID":"openai","credentialID":"cred_work","accountGeneration":{}}}"#,
                selected.account_generation()
            ))
            .as_str()
        )
    );
    credentials
        .create(
            "cred_replacement".into(),
            "openai".into(),
            Some("Work".into()),
            key("fixture-replacement-key"),
            3,
        )
        .await
        .unwrap();
    assert!(
        matches!(coordinator.run(&id).await, Err(ycoding_core::session::run_coordinator::Error::Runner(error)) if error.r#type.as_str() == Some("model.profile"))
    );
    assert!(requests.try_recv().is_err());
    service.publish(ycoding_store::session::NewEvent { id: "evt_reselected".into(), aggregate_id: "ses_one".into(), created: 4, type_: "session.model.selected.1".into(), data: parse_json(r#"{"sessionID":"ses_one","model":{"providerID":"openai","id":"gpt-reasoning","profile":"Work"}}"#).unwrap() }).await.unwrap();
    coordinator.run(&id).await.unwrap();
    let ycoding_schema::JsonValue::Object(request) = requests.recv().await.unwrap() else {
        panic!()
    };
    assert_eq!(
        request.get(&"_testAuthorization".into()),
        Some(&ycoding_schema::JsonValue::String(
            "Bearer fixture-replacement-key".into()
        ))
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    credentials.shutdown().await.unwrap();
}

#[tokio::test]
async fn settled_empty_output_gets_one_text_only_recovery_without_an_extra_user_prompt() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![EMPTY, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|message| matches!(
                message,
                ycoding_schema::session_message::Info::Assistant(_)
            ))
            .count(),
        2
    );
    assert_eq!(
        history
            .iter()
            .filter(|message| matches!(message, ycoding_schema::session_message::Info::User(_)))
            .count(),
        1
    );
    assert!(
        !history
            .iter()
            .any(|message| matches!(message, ycoding_schema::session_message::Info::Synthetic(_)))
    );
    requests.recv().await.unwrap();
    let recovery = requests.recv().await.unwrap();
    assert!(!ycoding_schema::stringify_json(&recovery).contains("\"tools\""));
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_second_empty_answer_fails_and_cannot_start_a_third_step() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![EMPTY, EMPTY]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    assert!(
        matches!(coordinator.run(&session::Id::new("ses_one").unwrap()).await, Err(ycoding_core::session::run_coordinator::Error::Runner(error)) if error.r#type.as_str() == Some("provider.invalid-output"))
    );
    requests.recv().await.unwrap();
    requests.recv().await.unwrap();
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|message| matches!(
                message,
                ycoding_schema::session_message::Info::Assistant(_)
            ))
            .count(),
        2
    );
    let ycoding_schema::session_message::Info::Assistant(assistant) = history.last().unwrap()
    else {
        panic!()
    };
    assert!(assistant.time.completed.is_some());
    assert!(assistant.error.is_some());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn registered_tool_settlement_is_reloaded_into_the_next_real_provider_request() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let registry = registry();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let called = calls.clone();
    let _registration = registry.register(vec![("echo".into(), Arc::new(ycoding_core::tools::registry::DynamicTool::new("Echo input", parse_json(r#"{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}"#).unwrap(), None, None, move |input, context| {
        let called = called.clone();
        Box::pin(async move { assert_eq!(context.session_id.as_lossless().as_str(), Some("ses_one")); assert_eq!(context.call_id.as_str(), Some("call_fixture")); called.fetch_add(1, std::sync::atomic::Ordering::SeqCst); Ok(ycoding_ai::llm::ToolOutput { structured: input, content: Vec::new() }) })
    })))], ycoding_core::tools::registry::Options::direct()).unwrap();
    let (endpoint, mut requests, server) = server(vec![TOOL, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry)));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(
        ycoding_schema::stringify_json(&requests.recv().await.unwrap())
            .contains("\"name\":\"echo\"")
    );
    let continuation = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(continuation.contains("\"role\":\"tool\""));
    assert!(continuation.contains("observed"));
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    assert_eq!(
        history
            .iter()
            .filter(|message| matches!(
                message,
                ycoding_schema::session_message::Info::Assistant(_)
            ))
            .count(),
        2
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn interruption_joins_owned_tool_work_and_closes_the_step_before_the_waiter_settles() {
    struct Dropped(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let registry = registry();
    let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let drop_flag = dropped.clone();
    let (started, mut begin) = mpsc::unbounded_channel();
    let _registration = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                    "Wait for cancellation",
                    parse_json(r#"{"type":"object"}"#).unwrap(),
                    None,
                    None,
                    move |_, context| {
                        let started = started.clone();
                        let dropped = drop_flag.clone();
                        Box::pin(async move {
                            let _dropped = Dropped(dropped);
                            started.send(()).unwrap();
                            context.cancellation.cancelled().await;
                            Err(ycoding_core::tools::registry::Failure::Cancelled)
                        })
                    },
                )),
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    let (endpoint, _requests, server) = server(vec![TOOL]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry)));
    let running = coordinator.clone();
    let task =
        tokio::spawn(async move { running.run(&session::Id::new("ses_one").unwrap()).await });
    begin.recv().await.unwrap();
    coordinator
        .interrupt(
            &session::Id::new("ses_one").unwrap(),
            ycoding_core::session::run_coordinator::InterruptReason::User,
        )
        .await
        .unwrap();
    assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
    assert!(matches!(
        task.await.unwrap(),
        Err(ycoding_core::session::run_coordinator::Error::Interrupted(
            _
        ))
    ));
    let history = service
        .context(&session::Id::new("ses_one").unwrap())
        .unwrap();
    let ycoding_schema::session_message::Info::Assistant(assistant) = history.last().unwrap()
    else {
        panic!()
    };
    assert!(assistant.time.completed.is_some());
    assert_eq!(
        assistant.error.as_ref().unwrap().r#type.as_str(),
        Some("aborted")
    );
    assert!(
        matches!(&assistant.content[0], ycoding_schema::session_message::AssistantContent::Tool(tool) if matches!(tool.state, ycoding_schema::session_message::ToolState::Error(_)))
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

const CACHED_ZERO: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\ndata: [DONE]\n\n";
const MALFORMED: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Partial\"},\"finish_reason\":null}]}\n\ndata: {not json}\n\n";
const RATE_LIMITED: &str = r#"{"error":{"message":"rate limited"}}"#;
const ONE_HOUR: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":100,\"cache_creation_input_tokens\":1000,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":600,\"ephemeral_1h_input_tokens\":400},\"output_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Answer\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
const IMPOSSIBLE_ONE_HOUR: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_2\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":100,\"cache_creation_input_tokens\":1000,\"cache_read_input_tokens\":0,\"cache_creation\":{\"ephemeral_5m_input_tokens\":0,\"ephemeral_1h_input_tokens\":2000},\"output_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Answer\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":50}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

fn count(types: &[String], kind: &str) -> usize {
    types
        .iter()
        .filter(|event| event.strip_suffix(".1") == Some(kind))
        .count()
}

fn admitting_echo(
    store: &ycoding_store::Store,
    inputs: Vec<(&'static str, &'static str, &'static str)>,
) -> (Arc<Registry>, Box<dyn std::any::Any>) {
    let registry = registry();
    let service = Service::new(store.client());
    let registration = registry
        .register(
            vec![(
                "echo".into(),
                Arc::new(ycoding_core::tools::registry::DynamicTool::new(
                    "Echo input",
                    parse_json(
                        r#"{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}"#,
                    )
                    .unwrap(),
                    None,
                    None,
                    move |input, _| {
                        let service = service.clone();
                        let inputs = inputs.clone();
                        Box::pin(async move {
                            for (name, text, delivery) in inputs {
                                admit_input(&service, name, text, delivery).await;
                            }
                            Ok(ycoding_ai::llm::ToolOutput {
                                structured: input,
                                content: Vec::new(),
                            })
                        })
                    },
                )),
            )],
            ycoding_core::tools::registry::Options::direct(),
        )
        .unwrap();
    (registry, Box::new(registration))
}

#[tokio::test]
async fn provider_cache_diagnostics_separate_unreported_telemetry_from_a_reported_zero() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server(vec![TEXT, CACHED_ZERO]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let first = last_assistant(&service);
    let diagnostics = first.diagnostics.as_ref().unwrap();
    let cache = diagnostics.provider_cache.as_ref().unwrap();
    assert_eq!(cache.mechanism.0.as_str(), Some("openai-prefix-cache"));
    assert!(!cache.read_reported);
    assert!(!cache.write_reported);
    assert_eq!(diagnostics.context_limit.as_ref().unwrap().get(), 128000);
    assert_eq!(first.tokens.as_ref().unwrap().cache.read.get(), 0.0);
    admit_input(&service, "second", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let cache = last_assistant(&service)
        .diagnostics
        .unwrap()
        .provider_cache
        .unwrap();
    assert!(cache.read_reported);
    assert!(!cache.write_reported);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn one_hour_cache_writes_bill_at_twice_input_and_impossible_metadata_keeps_the_five_minute_rate()
 {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server(vec![ONE_HOUR, IMPOSSIBLE_ONE_HOUR]).await;
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(r#"{"anthropic":{"id":"anthropic","name":"Anthropic","env":["ANTHROPIC_API_KEY"],"npm":"@ai-sdk/anthropic","api":"https://api.anthropic.com/v1","models":{"claude-priced":{"id":"claude-priced","name":"Claude Priced","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{"context":200000,"output":8192},"cost":{"input":3,"output":15,"cache_read":0.3,"cache_write":3.75}}}}}"#).unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"anthropic","model":"claude-priced"}},"providers":{{"anthropic":{{"package":"@ai-sdk/anthropic","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    let coordinator = Coordinator::new(Arc::new(local_services(
        &store,
        catalog,
        vec![agent::empty("build".into())],
        registry(),
        Arc::new(WallClock),
        Vec::new(),
    )));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let first = last_assistant(&service);
    let tokens = first.tokens.as_ref().unwrap();
    assert_eq!(tokens.input.get(), 100.0);
    assert_eq!(tokens.output.get(), 50.0);
    assert_eq!(tokens.cache.write.get(), 1000.0);
    assert!((first.cost.unwrap().get() - 0.0057).abs() < 1e-9);
    let cache = first.diagnostics.unwrap().provider_cache.unwrap();
    assert_eq!(cache.mechanism.0.as_str(), Some("anthropic-cache-control"));
    assert!(cache.read_reported);
    assert!(cache.write_reported);
    admit_input(&service, "second", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    assert!((last_assistant(&service).cost.unwrap().get() - 0.0048).abs() < 1e-9);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_malformed_provider_stream_after_output_publishes_exactly_one_terminal_step_failure() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server(vec![MALFORMED]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    assert!(
        matches!(coordinator.run(&session::Id::new("ses_one").unwrap()).await, Err(ycoding_core::session::run_coordinator::Error::Runner(error)) if error.r#type.as_str().is_some_and(|kind| kind.starts_with("provider.")))
    );
    let types = event_types(&store);
    assert_eq!(count(&types, "session.step.started"), 1);
    assert_eq!(count(&types, "session.step.failed"), 1);
    assert_eq!(count(&types, "session.step.ended"), 0);
    assert!(last_assistant(&service).error.is_some());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn retry_ceiling_stops_after_ten_physical_attempts_with_one_terminal_failure() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server_status(vec![(429, RATE_LIMITED); 10]).await;
    let delays = Arc::new(std::sync::Mutex::new(Vec::new()));
    let coordinator = Coordinator::new(Arc::new(local_clock(
        &store,
        &endpoint,
        registry(),
        Arc::new(ImmediateClock(delays.clone())),
    )));
    assert!(
        matches!(coordinator.run(&session::Id::new("ses_one").unwrap()).await, Err(ycoding_core::session::run_coordinator::Error::Runner(error)) if error.r#type.as_str() == Some("provider.rate-limit"))
    );
    assert_eq!(
        *delays.lock().unwrap(),
        vec![
            2000, 4000, 8000, 16000, 32000, 64000, 120000, 120000, 120000
        ]
    );
    for _ in 0..10 {
        requests.recv().await.unwrap();
    }
    let types = event_types(&store);
    assert_eq!(count(&types, "session.retry.scheduled"), 9);
    assert_eq!(count(&types, "session.step.started"), 1);
    assert_eq!(count(&types, "session.step.failed"), 1);
    assert_eq!(count(&types, "session.step.ended"), 0);
    assert!(last_assistant(&service).error.is_some());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn provider_retry_after_extends_but_never_shortens_the_exponential_backoff() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server_headers(vec![
        (429, "retry-after-ms: 500\r\n", RATE_LIMITED),
        (429, "", RATE_LIMITED),
        (429, "retry-after-ms: 1000\r\n", RATE_LIMITED),
        (429, "retry-after-ms: 30000\r\n", RATE_LIMITED),
        (200, "", TEXT),
    ])
    .await;
    let delays = Arc::new(std::sync::Mutex::new(Vec::new()));
    let coordinator = Coordinator::new(Arc::new(local_clock(
        &store,
        &endpoint,
        registry(),
        Arc::new(ImmediateClock(delays.clone())),
    )));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert_eq!(*delays.lock().unwrap(), vec![2000, 4000, 8000, 30000]);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn interruption_during_retry_backoff_closes_the_step_with_one_aborted_failure() {
    struct Stalled(mpsc::UnboundedSender<u64>);
    impl ycoding_core::session::runner::Clock for Stalled {
        fn now(&self) -> i64 {
            10
        }
        fn sleep(
            &self,
            milliseconds: u64,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
            self.0.send(milliseconds).unwrap();
            Box::pin(std::future::pending())
        }
    }
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server_status(vec![(429, RATE_LIMITED)]).await;
    let (slept, mut backoff) = mpsc::unbounded_channel();
    let coordinator = Coordinator::new(Arc::new(local_clock(
        &store,
        &endpoint,
        registry(),
        Arc::new(Stalled(slept)),
    )));
    let running = coordinator.clone();
    let task =
        tokio::spawn(async move { running.run(&session::Id::new("ses_one").unwrap()).await });
    assert_eq!(backoff.recv().await.unwrap(), 2000);
    coordinator
        .interrupt(
            &session::Id::new("ses_one").unwrap(),
            ycoding_core::session::run_coordinator::InterruptReason::User,
        )
        .await
        .unwrap();
    assert!(matches!(
        task.await.unwrap(),
        Err(ycoding_core::session::run_coordinator::Error::Interrupted(
            _
        ))
    ));
    let types = event_types(&store);
    assert_eq!(count(&types, "session.retry.scheduled"), 1);
    assert_eq!(count(&types, "session.step.started"), 1);
    assert_eq!(count(&types, "session.step.failed"), 1);
    assert_eq!(count(&types, "session.step.ended"), 0);
    let assistant = last_assistant(&service);
    assert!(assistant.time.completed.is_some());
    assert_eq!(
        assistant.error.as_ref().unwrap().r#type.as_str(),
        Some("aborted")
    );
    let rows = provider_requests(&store);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].attempts, 1);
    assert_eq!(rows[0].invalidation.as_str(), Some("provider-not-reported"));
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn steers_promote_at_the_next_step_while_a_queued_input_waits_for_idle() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (registry, _registration) = admitting_echo(
        &store,
        vec![
            ("queued", "Queued question", "queue"),
            ("steered", "Steered question", "steer"),
        ],
    );
    let (endpoint, mut requests, server) = server(vec![TOOL, TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry)));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let third = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!first.contains("Steered question") && !first.contains("Queued question"));
    assert!(second.contains("Steered question"));
    assert!(!second.contains("Queued question"));
    assert!(third.contains("Steered question") && third.contains("Queued question"));
    assert!(
        service
            .pending_list(&session::Id::new("ses_one").unwrap())
            .unwrap()
            .is_empty()
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn promoting_new_user_input_resets_the_step_allowance() {
    let allowance = |steps: i64| {
        let mut build = agent::empty("build".into());
        build.steps = Some(ycoding_schema::schema::PositiveInt::new(steps).unwrap());
        vec![build]
    };
    let catalog = |endpoint: &str| {
        let mut catalog = Catalog::new(
            models_dev::normalize(
                &parse_json(include_str!(
                    "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
                ))
                .unwrap(),
            )
            .unwrap(),
        );
        catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
        catalog
    };

    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (registry_without_input, _registration) = admitting_echo(&store, Vec::new());
    let (endpoint, mut requests, server_without_input) = server(vec![TOOL, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local_services(
        &store,
        catalog(&endpoint),
        allowance(2),
        registry_without_input,
        Arc::new(WallClock),
        Vec::new(),
    )));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert!(ycoding_schema::stringify_json(&requests.recv().await.unwrap()).contains("\"tools\""));
    assert!(!ycoding_schema::stringify_json(&requests.recv().await.unwrap()).contains("\"tools\""));
    server_without_input.await.unwrap();
    coordinator.shutdown().await.unwrap();

    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (registry_with_input, _registration) =
        admitting_echo(&store, vec![("steered", "Steered question", "steer")]);
    let (endpoint, mut requests, server_with_input) = server(vec![TOOL, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local_services(
        &store,
        catalog(&endpoint),
        allowance(2),
        registry_with_input,
        Arc::new(WallClock),
        Vec::new(),
    )));
    coordinator
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    assert!(ycoding_schema::stringify_json(&requests.recv().await.unwrap()).contains("\"tools\""));
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(second.contains("Steered question"));
    assert!(second.contains("\"tools\""));
    server_with_input.await.unwrap();
    coordinator.shutdown().await.unwrap();
    drop(service);
}

const EMPTY_USED: &str = "data: {\"id\":\"empty\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":0}}\n\ndata: [DONE]\n\n";

#[tokio::test]
async fn a_failed_step_after_a_settled_answer_keeps_usage_cost_and_cache_diagnostics() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server(vec![EMPTY_USED, EMPTY_USED]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    assert!(
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .is_err()
    );
    let assistant = last_assistant(&service);
    assert!(assistant.error.is_some());
    assert_eq!(assistant.tokens.as_ref().unwrap().input.get(), 5.0);
    assert!(assistant.cost.is_some());
    let diagnostics = assistant.diagnostics.as_ref().unwrap();
    assert_eq!(diagnostics.context_limit.as_ref().unwrap().get(), 128000);
    assert!(!diagnostics.provider_cache.as_ref().unwrap().read_reported);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn step_limit_notice_and_its_reset_are_durable_system_observations() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (registry, _registration) = admitting_echo(&store, Vec::new());
    let mut build = agent::empty("build".into());
    build.steps = Some(ycoding_schema::schema::PositiveInt::new(2).unwrap());
    let (endpoint, mut requests, server) = server(vec![TOOL, TEXT, TEXT]).await;
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    let coordinator = Coordinator::new(Arc::new(local_services(
        &store,
        catalog,
        vec![build],
        registry,
        Arc::new(WallClock),
        Vec::new(),
    )));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let limited = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!first.contains("MAXIMUM STEPS REACHED"));
    assert!(limited.contains("CRITICAL - MAXIMUM STEPS REACHED"));
    assert!(!limited.contains("\"tools\""));
    admit_input(&service, "again", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let reset = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(reset.contains("CRITICAL - MAXIMUM STEPS REACHED"));
    assert!(
        reset.contains("The maximum-step constraint from an earlier user input no longer applies")
    );
    assert!(reset.contains("\"tools\""));
    assert_eq!(
        observed(&store)
            .iter()
            .filter(|source| *source == "step-limit")
            .count(),
        2
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

const CACHED_HIT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"prompt_tokens_details\":{\"cached_tokens\":2}}}\n\ndata: [DONE]\n\n";

fn provider_requests(store: &ycoding_store::Store) -> Vec<ycoding_store::resources::Request> {
    ycoding_store::resources::requests(
        &store.snapshot().unwrap(),
        &"ses_one".into(),
        ycoding_store::IndexOrder::Ascending,
        None,
        50,
    )
    .unwrap()
    .into_iter()
    .map(|entry| entry.record)
    .collect()
}

#[tokio::test]
async fn each_logical_step_records_one_provider_request_with_attempts_cache_and_usage() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server_status(vec![
        (429, RATE_LIMITED),
        (200, CACHED_ZERO),
        (200, CACHED_HIT),
    ])
    .await;
    let delays = Arc::new(std::sync::Mutex::new(Vec::new()));
    let coordinator = Coordinator::new(Arc::new(local_clock(
        &store,
        &endpoint,
        registry(),
        Arc::new(ImmediateClock(delays)),
    )));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let first_assistant = last_assistant(&service);
    admit_input(&service, "second", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let rows = provider_requests(&store);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].request, 1);
    assert_eq!(rows[0].attempts, 2);
    assert_eq!(rows[0].source.as_str(), Some("step"));
    assert_eq!(rows[0].route_id.as_str(), Some("openai-compatible-chat"));
    assert_eq!(rows[0].invalidation.as_str(), Some("first-request"));
    assert_eq!(rows[0].continuation.as_str(), Some("full"));
    assert_eq!(rows[0].cache_read_reported, Some(1));
    assert_eq!(
        rows[0]
            .assistant_message_id
            .as_ref()
            .and_then(|id| id.as_str()),
        Some(first_assistant.id.as_lossless().as_str().unwrap())
    );
    for digest in [
        rows[0].connection_identity_digest.as_ref().unwrap(),
        &rows[0].prompt_cache_key,
        &rows[0].system_digest,
        &rows[0].tool_digest,
    ] {
        assert_eq!(digest.as_str().unwrap().len(), 64);
    }
    assert_eq!(rows[1].request, 2);
    assert_eq!(rows[1].attempts, 1);
    assert_eq!(rows[1].invalidation.as_str(), Some("stable-hit"));
    assert_eq!(rows[1].prompt_cache_key, rows[0].prompt_cache_key);
    assert_eq!(rows[1].tokens.domain().unwrap().cache.read.get(), 2.0);
    let usage = store
        .snapshot()
        .unwrap()
        .get::<ycoding_store::resources::UsageTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
            ycoding_store::KeyPart::String(&r#"["openai","gpt-reasoning",null,null]"#.into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!((usage.logical, usage.physical), (2, 3));
    assert_eq!(usage.cache_read, 2);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_step_that_fails_before_settlement_records_a_not_reported_zero_usage_request() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server(vec![MALFORMED]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    assert!(
        coordinator
            .run(&session::Id::new("ses_one").unwrap())
            .await
            .is_err()
    );
    let rows = provider_requests(&store);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].invalidation.as_str(), Some("provider-not-reported"));
    assert_eq!(rows[0].cache_read_reported, None);
    assert_eq!(rows[0].cost, None);
    assert_eq!(rows[0].tokens.domain().unwrap().input.get(), 0.0);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

const THINKING: &str = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_t\",\"role\":\"assistant\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Plan the answer\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig_fixture\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Answer\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":5}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";

fn anthropic_local(store: &ycoding_store::Store, endpoint: &str, api_key: &str) -> Local {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(r#"{"anthropic":{"id":"anthropic","name":"Anthropic","env":["ANTHROPIC_API_KEY"],"npm":"@ai-sdk/anthropic","api":"https://api.anthropic.com/v1","models":{"claude-priced":{"id":"claude-priced","name":"Claude Priced","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{"context":200000,"output":8192}}}}}"#).unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"anthropic","model":"claude-priced"}},"providers":{{"anthropic":{{"package":"@ai-sdk/anthropic","settings":{{"apiKey":"{api_key}","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    local_services(
        store,
        catalog,
        vec![agent::empty("build".into())],
        registry(),
        Arc::new(WallClock),
        Vec::new(),
    )
}

#[tokio::test]
async fn captured_reasoning_state_replays_only_for_the_same_model_and_account() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![THINKING, ONE_HOUR, ONE_HOUR]).await;
    let id = session::Id::new("ses_one").unwrap();
    let same = Coordinator::new(Arc::new(anthropic_local(&store, &endpoint, "fixture")));
    same.run(&id).await.unwrap();
    let assistant = last_assistant(&service);
    let ycoding_schema::session_message::AssistantContent::Reasoning(reasoning) =
        &assistant.content[0]
    else {
        panic!()
    };
    assert_eq!(
        reasoning.state.as_ref().unwrap().get(&"signature".into()),
        Some(&ycoding_schema::JsonValue::String("sig_fixture".into()))
    );
    requests.recv().await.unwrap();
    admit_input(&service, "second", "Again", "steer").await;
    same.run(&id).await.unwrap();
    let replayed = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(replayed.contains("\"type\":\"thinking\""));
    assert!(replayed.contains("\"signature\":\"sig_fixture\""));
    same.shutdown().await.unwrap();

    let other = Coordinator::new(Arc::new(anthropic_local(&store, &endpoint, "rotated")));
    admit_input(&service, "third", "Once more", "steer").await;
    other.run(&id).await.unwrap();
    let refused = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!refused.contains("sig_fixture"));
    assert!(!refused.contains("\"type\":\"thinking\""));
    assert!(refused.contains("Plan the answer"));
    server.await.unwrap();
    other.shutdown().await.unwrap();
}

const RESPONSES: &str = include_str!("../../ai/tests/fixtures/openai-responses-reasoning.sse");
const RESPONSE_ID: &str = "resp_05f7e55dc1d2d743016a1235e5bb3c8193b4c0e30fa316700c";

fn responses_local(
    store: &ycoding_store::Store,
    endpoint: &str,
    api_key: &str,
    model: &str,
) -> Local {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(&format!(r#"{{"openai":{{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai","api":"https://api.openai.com/v1","models":{{"{model}":{{"id":"{model}","name":"Responses Model","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{{"context":128000,"output":8192}}}}}}}}}}"#)).unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"{model}"}},"providers":{{"openai":{{"package":"@ai-sdk/openai","settings":{{"apiKey":"{api_key}","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    local_services(
        store,
        catalog,
        vec![agent::empty("build".into())],
        registry(),
        Arc::new(WallClock),
        Vec::new(),
    )
}

fn initial_context(store: &ycoding_store::Store) {
    store
        .submit(|tx| {
            ycoding_store::session::RevisionTable::insert(
                tx,
                &ycoding_store::session::Revision {
                    session_id: "ses_one".into(),
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
            ycoding_store::session::ContextStateTable::insert(
                tx,
                &ycoding_store::session::ContextState {
                    session_id: "ses_one".into(),
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
        .wait()
        .unwrap();
}

fn wire_key(body: &str) -> String {
    let marker = "\"prompt_cache_key\":\"";
    let start = body.find(marker).unwrap() + marker.len();
    body[start..start + 64].to_string()
}

#[tokio::test]
async fn responses_continuation_reuses_the_stored_response_only_for_the_same_account() {
    let store = support::store();
    initial_context(&store);
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![RESPONSES, RESPONSES, RESPONSES]).await;
    let id = session::Id::new("ses_one").unwrap();
    let same = Coordinator::new(Arc::new(responses_local(
        &store, &endpoint, "fixture", "gpt-5.5",
    )));
    same.run(&id).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!first.contains("previous_response_id"));
    assert!(first.contains("\"store\":true"));
    admit_input(&service, "second", "Again", "steer").await;
    same.run(&id).await.unwrap();
    let continued = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(continued.contains(&format!("\"previous_response_id\":\"{RESPONSE_ID}\"")));
    assert!(continued.contains("Again"));
    assert!(!continued.contains("Answer the prompt"));
    same.shutdown().await.unwrap();

    let other = Coordinator::new(Arc::new(responses_local(
        &store, &endpoint, "rotated", "gpt-5.5",
    )));
    admit_input(&service, "third", "Once more", "steer").await;
    other.run(&id).await.unwrap();
    let refused = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!refused.contains("previous_response_id"));
    assert!(refused.contains("Answer the prompt"));
    assert!(refused.contains("Once more"));
    let rows = provider_requests(&store);
    assert_eq!(
        rows.iter()
            .map(|row| row.continuation.as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec!["full", "continued", "full"]
    );
    assert_ne!(
        wire_key(&first),
        rows[0].prompt_cache_key.as_str().unwrap().to_string()
    );
    assert_eq!(wire_key(&first), wire_key(&continued));
    server.await.unwrap();
    other.shutdown().await.unwrap();
}

fn azure_local(store: &ycoding_store::Store, endpoint: &str, api_key: &str) -> Local {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(r#"{"azure":{"id":"azure","name":"Azure","env":["AZURE_API_KEY"],"npm":"@ai-sdk/azure","api":"https://resource.openai.azure.com/openai/v1","models":{"gpt-5.5":{"id":"gpt-5.5","name":"Responses Model","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"limit":{"context":128000,"output":8192}}}}}"#).unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"azure","model":"gpt-5.5"}},"providers":{{"azure":{{"package":"@ycoding-ai/ai/providers/azure/responses","settings":{{"apiKey":"{api_key}","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    local_services(
        store,
        catalog,
        vec![agent::empty("build".into())],
        registry(),
        Arc::new(WallClock),
        Vec::new(),
    )
}

fn with_compaction_item() -> &'static str {
    let item = "event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"compaction\",\"id\":\"cmp_stream\",\"encrypted_content\":\"OPAQUE-ENCRYPTED\"}}\n\n";
    let at = RESPONSES.find("event: response.output_item.added").unwrap();
    Box::leak(format!("{}{item}{}", &RESPONSES[..at], &RESPONSES[at..]).into_boxed_str())
}

fn reasoning_ended(store: &ycoding_store::Store) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.record.type_.as_str() == Some("session.reasoning.ended.1"))
        .map(|event| ycoding_schema::stringify_json(&event.record.data))
        .collect()
}

#[tokio::test]
async fn an_opaque_compaction_item_is_captured_redacted_and_replayed_only_for_the_same_account() {
    let store = support::store();
    initial_context(&store);
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) =
        server(vec![with_compaction_item(), RESPONSES, RESPONSES]).await;
    let id = session::Id::new("ses_one").unwrap();
    let same = Coordinator::new(Arc::new(azure_local(&store, &endpoint, "fixture")));
    same.run(&id).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(!first.contains("OPAQUE-ENCRYPTED"));

    let ended = reasoning_ended(&store);
    assert_eq!(ended.len(), 2);
    assert!(
        ended
            .iter()
            .all(|event| !event.contains("OPAQUE-ENCRYPTED"))
    );
    assert!(
        ended
            .iter()
            .all(|event| !event.contains("opaqueCompactionItem"))
    );

    let snapshot = store.snapshot().unwrap();
    let links = snapshot
        .index_range::<ycoding_store::resources::StateLinkTable>(
            "session_provider_state_link_revision_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"ses_one".into()),
                ])),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 10,
            },
        )
        .unwrap();
    let [link] = links.as_slice() else {
        panic!("expected exactly one captured provider state link")
    };
    let link = &link.record;
    assert_eq!(link.part_ordinal, 0);
    assert_eq!(link.part_kind.as_str(), Some("reasoning"));
    assert_eq!(link.provider.as_str(), Some("azure"));
    assert_eq!(link.model_id.as_str(), Some("gpt-5.5"));
    assert_eq!(link.context_revision, 0);
    assert_eq!(
        ycoding_schema::JsonValue::String(link.message_id.clone()),
        ycoding_schema::DomainEncode::encode(&last_assistant(&service).id)
    );
    let blob = snapshot
        .get::<ycoding_store::resources::StateBlobTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&link.blob_digest),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(blob.item_type.as_str(), Some("compaction"));
    let item = parse_json(
        r#"{"type":"compaction","id":"cmp_stream","encrypted_content":"OPAQUE-ENCRYPTED"}"#,
    )
    .unwrap();
    assert_eq!(blob.content.value(), &item);
    assert_eq!(
        link.blob_digest.as_str(),
        Some(
            ycoding_core::session::prompt_cache::sha256(
                &ycoding_core::session::prompt_cache::canonical_json(&item)
            )
            .as_str()
        )
    );

    admit_input(&service, "second", "Again", "steer").await;
    same.run(&id).await.unwrap();
    let replayed = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(replayed.contains("\"store\":false"));
    assert!(replayed.contains(
        "{\"type\":\"compaction\",\"id\":\"cmp_stream\",\"encrypted_content\":\"OPAQUE-ENCRYPTED\"}"
    ));
    same.shutdown().await.unwrap();

    let other = Coordinator::new(Arc::new(azure_local(&store, &endpoint, "rotated")));
    admit_input(&service, "third", "Once more", "steer").await;
    other.run(&id).await.unwrap();
    let refused = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(refused.contains("Once more"));
    assert!(!refused.contains("OPAQUE-ENCRYPTED"));
    server.await.unwrap();
    other.shutdown().await.unwrap();
}

#[tokio::test]
async fn prompt_cache_options_follow_the_model_family_and_anthropic_policy() {
    let store = support::store();
    initial_context(&store);
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![RESPONSES, RESPONSES, ONE_HOUR]).await;
    let modern = Coordinator::new(Arc::new(responses_local(
        &store, &endpoint, "fixture", "gpt-5.6",
    )));
    modern
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let modern_body = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(
        modern_body.contains("\"prompt_cache_options\":{\"mode\":\"implicit\",\"ttl\":\"30m\"}")
    );
    assert!(!modern_body.contains("prompt_cache_retention"));
    modern.shutdown().await.unwrap();

    let store = support::store();
    initial_context(&store);
    let service = Service::new(store.client());
    admit(&service).await;
    let legacy = Coordinator::new(Arc::new(responses_local(
        &store, &endpoint, "fixture", "gpt-5.5",
    )));
    legacy
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let legacy_body = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(legacy_body.contains("\"prompt_cache_key\""));
    assert!(!legacy_body.contains("prompt_cache_options"));
    legacy.shutdown().await.unwrap();

    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let anthropic = Coordinator::new(Arc::new(anthropic_local(&store, &endpoint, "fixture")));
    anthropic
        .run(&session::Id::new("ses_one").unwrap())
        .await
        .unwrap();
    let anthropic_body = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(anthropic_body.contains("\"cache_control\":{\"type\":\"ephemeral\"}"));
    server.await.unwrap();
    anthropic.shutdown().await.unwrap();
}

#[tokio::test]
async fn request_timing_is_recorded_only_after_telemetry_consent() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, _requests, server) = server(vec![TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    store
        .submit(|tx| {
            ycoding_store::resources::ConsentTable::insert(
                tx,
                &ycoding_store::resources::Consent {
                    id: 1,
                    enabled: 1,
                    notice_version: 1,
                    decided_at: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    admit_input(&service, "second", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let rows = provider_requests(&store);
    assert!(rows[0].timing.is_none());
    let timing = rows[1].timing.as_ref().unwrap().domain().unwrap();
    assert!(timing.first_output_ms.is_some());
    assert!(timing.total_ms.is_some());
    assert_eq!(timing.retry_wait_ms.unwrap().get(), 0);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

const INVALID_PREVIOUS: &str = r#"{"error":{"message":"Previous response with id 'resp_x' not found.","type":"invalid_request_error","param":"previous_response_id","code":"previous_response_not_found"}}"#;

async fn assert_fallback(rejection: &'static str) {
    let store = support::store();
    initial_context(&store);
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) =
        server_status(vec![(200, RESPONSES), (400, rejection), (200, RESPONSES)]).await;
    let coordinator = Coordinator::new(Arc::new(responses_local(
        &store, &endpoint, "fixture", "gpt-5.5",
    )));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    requests.recv().await.unwrap();
    admit_input(&service, "second", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let rejected = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let replay = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(rejected.contains("previous_response_id"));
    assert!(!replay.contains("previous_response_id"));
    assert!(replay.contains("Answer the prompt"));
    assert!(replay.contains("Again"));
    let rows = provider_requests(&store);
    assert_eq!(
        rows.iter()
            .map(|row| row.continuation.as_str().unwrap().to_string())
            .collect::<Vec<_>>(),
        vec!["full", "fallback"]
    );
    assert_eq!(rows[1].attempts, 2);
    assert_eq!(rows[1].invalidation.as_str(), Some("retry-fallback"));
    assert!(last_assistant(&service).error.is_none());
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_rejected_previous_response_falls_back_to_one_full_replay_and_records_it() {
    assert_fallback(INVALID_PREVIOUS).await;
}

#[tokio::test]
async fn a_missing_previous_response_without_an_error_type_still_falls_back() {
    assert_fallback(r#"{"error":{"message":"Previous response with id 'resp_x' not found."}}"#)
        .await;
}

fn analysis_local(
    store: &ycoding_store::Store,
    endpoint: &str,
    analysis: Arc<ycoding_core::session::analysis::Analysis>,
) -> Local {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    Local::new(Services {
        store: Service::new(store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(vec![
            agent::empty("build".into()),
            ycoding_core::session::analysis::analysis_agent(),
        ])),
        credentials: credential::Service::new(store.client()),
        tools: registry(),
        attachments: Arc::new(
            attachment_store::Store::new(std::env::temp_dir().join("ycoding-runner-attachments"))
                .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: Some(analysis),
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
    })
}

#[tokio::test]
async fn meeting_analysis_generates_through_a_bounded_toolless_child_session() {
    use ycoding_core::session::analysis::{Analysis, Generator, SYSTEM};
    let store = support::store();
    let service = Service::new(store.client());
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT]).await;
    let analysis = Analysis::new(60);
    let coordinator = Coordinator::new(Arc::new(analysis_local(
        &store,
        &endpoint,
        analysis.clone(),
    )));
    let location =
        ycoding_schema::location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap())
            .unwrap();
    let generator = Arc::new(Generator::new(
        Service::new(store.client()),
        coordinator.clone(),
        analysis,
        location,
        ycoding_schema::project::Id::new("prj_one").unwrap(),
        None,
    ));
    let generate: ycoding_core::meeting::intelligence::Generate = {
        let generator = generator.clone();
        Arc::new(move |session, prompt| {
            let generator = generator.clone();
            Box::pin(async move { generator.generate(&session, &prompt).await })
        })
    };
    let parent = generator.create_session(Some("ses_one")).await.unwrap();
    let info = service
        .get(&session::Id::new(parent.as_str()).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        info.agent.as_ref().and_then(|agent| agent.as_str()),
        Some("meeting-intelligence")
    );
    assert_eq!(
        info.parent_id
            .as_ref()
            .and_then(|id| id.as_lossless().as_str()),
        Some("ses_one")
    );
    assert_eq!(
        generate(parent.clone(), "First meeting data".into())
            .await
            .unwrap(),
        "Answer"
    );
    assert_eq!(
        generate(parent.clone(), "Second meeting data".into())
            .await
            .unwrap(),
        "Answer"
    );
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(first.contains(SYSTEM) && second.contains(SYSTEM));
    assert!(first.contains("First meeting data"));
    assert!(second.contains("Second meeting data"));
    assert!(!second.contains("First meeting data"));
    assert!(!first.contains("\"tools\"") && !second.contains("\"tools\""));
    let oversized = "x".repeat(61);
    assert!(
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            generate(parent.clone(), oversized)
        )
        .await
        .unwrap()
        .unwrap_err()
        .contains("bounded")
    );
    assert!(
        generate("ses_unknown".into(), "Data".into())
            .await
            .unwrap_err()
            .contains("Unknown analysis Session")
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn meeting_analysis_refuses_a_parent_from_another_location() {
    use ycoding_core::session::analysis::{Analysis, Generator};
    let store = support::store();
    store
        .submit(|tx| {
            let mut row = tx
                .get::<ycoding_store::session::SessionTable>(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&"ses_two".into()),
                ]))?
                .unwrap();
            row.directory = "/elsewhere".into();
            ycoding_store::session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let (endpoint, _requests, server) = server(Vec::new()).await;
    let analysis = Analysis::new(60);
    let coordinator = Coordinator::new(Arc::new(analysis_local(
        &store,
        &endpoint,
        analysis.clone(),
    )));
    let generator = Generator::new(
        Service::new(store.client()),
        coordinator.clone(),
        analysis,
        ycoding_schema::location::Ref::decode(&parse_json(r#"{"directory":"/project"}"#).unwrap())
            .unwrap(),
        ycoding_schema::project::Id::new("prj_one").unwrap(),
        None,
    );
    assert!(
        generator
            .create_session(Some("ses_two"))
            .await
            .unwrap_err()
            .contains("Open the source Session's Location")
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

fn cursor_host() -> ycoding_core::resources::cursor::route::Host {
    ycoding_core::resources::cursor::route::Host {
        identity: ycoding_ai::cursor::headers::Identity {
            machine_id: "machine".into(),
            mac_machine_id: None,
            client_version: "1.0.0".into(),
        },
        context: ycoding_ai::cursor::provider::RequestContext::new(vec![0x22, 0x00]).unwrap(),
        runtime: Arc::new(
            ycoding_ai::cursor::provider::Runtime::new(
                ycoding_ai::cursor::transport::Options::default(),
            )
            .unwrap(),
        ),
        known_mcp_servers: vec![],
    }
}

fn cursor_catalog(endpoint: &str) -> Catalog {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    ycoding_core::resources::cursor::catalog::sync(
        &mut catalog,
        ycoding_core::resources::cursor::models::from_cursor(&[ycoding_ai::cursor::models::Info {
            id: "composer-2.5".into(),
            display_name: "Composer 2.5".into(),
            supports_thinking: false,
            supports_agent: true,
            supports_images: None,
            max_context: None,
            max_context_max_mode: None,
            supports_max_mode: false,
            variants: vec![],
        }]),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"cursor","model":"composer-2.5"}},"providers":{{"cursor":{{"settings":{{"apiKey":"crsr_fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    catalog
}

#[tokio::test]
async fn cursor_model_resolves_through_the_host_route_and_carries_the_non_cursor_identity_instruction()
 {
    use ycoding_core::resources::cursor::system::INSTRUCTION;
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let coordinator = Coordinator::new(Arc::new(local_hosted(
        &store,
        cursor_catalog("http://127.0.0.1:1"),
        vec![agent::empty("build".into())],
        registry(),
        Arc::new(ImmediateClock(Default::default())),
        Vec::new(),
        Some(cursor_host()),
    )));
    let _ = coordinator.run(&session::Id::new("ses_one").unwrap()).await;
    let rows = provider_requests(&store);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].route_id.as_str(), Some("cursor-connect"));
    assert_eq!(
        rows[0].system_digest.as_str(),
        Some(ycoding_core::session::prompt_cache::system_digest(&[INSTRUCTION.into()]).as_str())
    );
    coordinator.shutdown().await.unwrap();
}

fn observed(store: &ycoding_store::Store) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .filter(|event| event.record.type_.as_str() == Some("session.context.observed.1"))
        .filter_map(|event| match event.record.data {
            ycoding_schema::JsonValue::Object(data) => match data.get(&"source".into()) {
                Some(ycoding_schema::JsonValue::String(source)) => {
                    source.as_str().map(str::to_owned)
                }
                _ => None,
            },
            _ => None,
        })
        .collect()
}

fn child_task(state: &str, revision: i64) -> ycoding_store::session::Task {
    ycoding_store::session::Task {
        session_id: "ses_two".into(),
        parent_id: "ses_one".into(),
        parent_assistant_message_id: "msg_assistant".into(),
        tool_call_id: "call".into(),
        input_id: "msg_input".into(),
        description: "child work".into(),
        agent: "build".into(),
        model: ycoding_store::session::Document::new(
            parse_json(r#"{"providerID":"local","id":"test"}"#).unwrap(),
        )
        .unwrap(),
        prompt_digest: "e".repeat(64).into(),
        background: 1,
        delivery: "steer".into(),
        state: state.into(),
        progress: None,
        progress_time: None,
        question_id: None,
        question: None,
        question_data: None,
        question_time: None,
        attempt_started: 0,
        revision,
        time_created: 1,
        time_updated: 1,
    }
}

const STATE_PREFIX: &str = "Authoritative current Session state (JSON):";

#[tokio::test]
async fn session_state_is_observed_as_a_system_message_only_when_it_changes() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(first.contains(STATE_PREFIX));
    assert_eq!(observed(&store), vec!["session-state"]);
    admit_input(&service, "unchanged", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(second.contains(STATE_PREFIX));
    assert_eq!(observed(&store), vec!["session-state"]);
    store
        .submit(|tx| {
            ycoding_store::session::TodoTable::insert(
                tx,
                &ycoding_store::session::Todo {
                    session_id: "ses_one".into(),
                    content: "Ship the observation".into(),
                    status: "pending".into(),
                    priority: "high".into(),
                    position: 0,
                    time_created: 1,
                    time_updated: 1,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    admit_input(&service, "changed", "Once more", "steer").await;
    coordinator.run(&id).await.unwrap();
    let third = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(third.contains("Ship the observation"));
    assert_eq!(observed(&store), vec!["session-state", "session-state"]);
    let history = service.context(&id).unwrap();
    let states = history
        .iter()
        .filter(|message| {
            matches!(message, session_message::Info::System(system)
                if system.text.as_str().is_some_and(|text| text.starts_with(STATE_PREFIX)))
        })
        .count();
    assert_eq!(states, 2);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn team_view_is_observed_as_user_context_and_an_emptied_team_is_announced_once() {
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    store
        .submit(|tx| ycoding_store::session::TaskTable::insert(tx, &child_task("running", 1)))
        .unwrap()
        .wait()
        .unwrap();
    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT, TEXT]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint, registry())));
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    let first = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(first.contains("Internal orchestration context (JSON)"));
    assert!(first.contains("child work"));
    assert_eq!(observed(&store), vec!["session-state", "team-view"]);
    let history = service.context(&id).unwrap();
    assert!(history.iter().any(|message| matches!(
        message,
        session_message::Info::Synthetic(synthetic)
            if synthetic.description.as_ref().and_then(|text| text.as_str()) == Some("TeamView update")
    )));
    store
        .submit(|tx| {
            tx.delete::<ycoding_store::session::TaskTable>(&ycoding_store::tuple_key(&[
                ycoding_store::KeyPart::String(&"ses_two".into()),
            ]))
            .map(|_| ())
        })
        .unwrap()
        .wait()
        .unwrap();
    admit_input(&service, "emptied", "Again", "steer").await;
    coordinator.run(&id).await.unwrap();
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(second.contains(r#"\"children\":[]"#));
    assert_eq!(
        observed(&store),
        vec!["session-state", "team-view", "team-view"]
    );
    admit_input(&service, "settled", "Third", "steer").await;
    coordinator.run(&id).await.unwrap();
    requests.recv().await.unwrap();
    assert_eq!(
        observed(&store),
        vec!["session-state", "team-view", "team-view"]
    );
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
}

const MCP_TOOL: &str = "data: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_mcp\",\"type\":\"function\",\"function\":{\"name\":\"jobs_run_job\",\"arguments\":\"{\\\"background\\\":true}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"id\":\"tool\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";

#[tokio::test]
async fn a_backgrounded_mcp_completion_is_admitted_as_a_steer_input_and_wakes_the_next_step() {
    use ycoding_core::{
        job::{Jobs, Status},
        resources::{
            config::Entry,
            mcp::{Service as Mcp, client::Hooks},
        },
        session::runner::mcp_notifier,
        tools::{
            builtin::mcp::{Background, McpTools},
            context::policy::LeafPolicy,
            policy::{Authority, Publisher, permissions::Permissions},
        },
    };
    let root = std::env::temp_dir().join(format!("ycoding-runner-mcp-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let state = root.join("jobs.json");
    std::fs::write(
        &state,
        serde_json::json!({
            "capabilities": {"tools": {"listChanged": true}},
            "responses": {"tools/list": {"": {"tools": [{"name": "run_job", "description": "Run a job", "inputSchema": {"type": "object", "properties": {}}}]}}},
            "calls": {"run_job": {"delay": 0.3, "result": {"content": [{"type": "text", "text": "done"}]}}},
            "log": root.join("jobs.log"),
        })
        .to_string(),
    )
    .unwrap();
    let entries = [Entry::Document {
        path: None,
        info: parse_json(
            &serde_json::json!({"mcp": {"servers": {"jobs": {
                "type": "local",
                "codemode": false,
                "command": ["python3", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mcp_table.py"), state],
            }}}})
            .to_string(),
        )
        .unwrap(),
    }];
    let mcp = Arc::new(
        Mcp::new(
            &entries,
            root.clone(),
            "1".into(),
            Default::default(),
            Hooks::default(),
        )
        .unwrap(),
    );
    let store = support::store();
    let service = Service::new(store.client());
    admit(&service).await;
    let allow = ycoding_schema::permission::Rule {
        action: "*".into(),
        resource: "*".into(),
        effect: ycoding_schema::permission::Effect("allow".into()),
    };
    let authority = Authority {
        store: store.client(),
        agents: Arc::new({
            let allow = allow.clone();
            move |agent| {
                Some((
                    agent.cloned().unwrap_or_else(|| "build".into()),
                    vec![allow.clone()],
                ))
            }
        }),
    };
    let publisher: Publisher = Arc::new(|_| Ok(()));
    let policy = Arc::new(LeafPolicy {
        permissions: Permissions::new(
            authority,
            ycoding_schema::project_id::ProjectId::new("prj_one").unwrap(),
            publisher,
        ),
        guardrails: guardrails::guardrails(&store),
    });
    let cell = Arc::new(std::sync::OnceLock::<Coordinator>::new());
    let wake = {
        let cell = cell.clone();
        Arc::new(move |id: &session::Id| cell.get().expect("coordinator is installed").wake(id))
    };
    let jobs = Jobs::new();
    let registry = registry();
    let tools = McpTools::start(
        mcp.clone(),
        registry.clone(),
        policy,
        Some(Background {
            jobs: jobs.clone(),
            notifier: mcp_notifier(Service::new(store.client()), Arc::new(WallClock), wake),
        }),
    );
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while !registry
            .materialize(&[])
            .definitions
            .iter()
            .any(|definition| definition.name.as_str() == Some("jobs_run_job"))
        {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("MCP tool registered");
    let (endpoint, mut requests, server) = server(vec![MCP_TOOL, TEXT, TEXT]).await;
    let mut build = agent::empty("build".into());
    build.permissions = vec![allow];
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(include_str!(
                "../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json"
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    let coordinator = Coordinator::new(Arc::new(local_services(
        &store,
        catalog,
        vec![build],
        registry,
        Arc::new(WallClock),
        Vec::new(),
    )));
    assert!(cell.set(coordinator.clone()).is_ok());
    let id = session::Id::new("ses_one").unwrap();
    coordinator.run(&id).await.unwrap();
    requests.recv().await.unwrap();
    let second = ycoding_schema::stringify_json(&requests.recv().await.unwrap());
    assert!(
        second.contains("The MCP tool was moved to the background."),
        "{second}"
    );
    let woken = tokio::time::timeout(std::time::Duration::from_secs(15), requests.recv())
        .await
        .expect("completion wakes the Session")
        .unwrap();
    let woken = ycoding_schema::stringify_json(&woken);
    assert!(woken.contains(r#"<mcp id=\"call_mcp\" state=\"completed\" tool=\"jobs_run_job\">"#));
    assert!(woken.contains("done"));
    assert_eq!(jobs.get("call_mcp").unwrap().status, Status::Completed);
    server.await.unwrap();
    coordinator.shutdown().await.unwrap();
    let history = service.context(&id).unwrap();
    assert!(history.iter().any(|message| matches!(
        message,
        session_message::Info::Synthetic(synthetic)
            if synthetic.description.as_ref().and_then(|text| text.as_str()) == Some("run_job")
                && synthetic.metadata.as_ref().is_some_and(|metadata| metadata.get(&"source".into())
                    == Some(&ycoding_schema::JsonValue::String("mcp".into())))
    )));
    let moved = history
        .iter()
        .find_map(|message| match message {
            session_message::Info::Assistant(assistant) => {
                assistant.content.iter().find_map(|part| match part {
                    session_message::AssistantContent::Tool(tool) => match &tool.state {
                        session_message::ToolState::Completed(state) => {
                            Some(state.structured.clone())
                        }
                        _ => None,
                    },
                    _ => None,
                })
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        ycoding_schema::stringify_json(&ycoding_schema::JsonValue::Object(moved)),
        r#"{"value":null}"#
    );
    tools.stop().await.unwrap();
    mcp.shutdown().await.unwrap();
    std::fs::remove_dir_all(root).unwrap();
}
