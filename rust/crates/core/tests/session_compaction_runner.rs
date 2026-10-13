use std::{collections::BTreeMap, sync::Arc};
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
        compaction_job::AdmitInput,
        compaction_policy::{Info, resolve},
        context_manifest,
        run_coordinator::Coordinator,
        runner::{Local, Services, WallClock},
        skill::{InstructionsFuture, Resolver, SkillsFuture},
        store::Service,
        summary_toon::{self, Memory},
    },
    tools::{
        policy::helper::{self, CompactionScope, ModelSelection},
        registry::Registry,
    },
};
use ycoding_schema::{
    DomainDecode, JsonValue, parse_json, session, session_compaction, session_message,
    session_pending, skill,
};
use ycoding_store::session::{
    ContextState, ContextStateTable, ManifestTable, Message, MessageTable, Revision, RevisionTable,
    Sequence, SequenceTable,
};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/mod.rs"]
mod support;

async fn server(
    replies: Vec<String>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    scripted(replies.into_iter().map(|reply| (200, reply)).collect()).await
}

async fn scripted(
    replies: Vec<(u16, String)>,
) -> (
    String,
    mpsc::UnboundedReceiver<JsonValue>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let (send, receive) = mpsc::unbounded_channel();
    let task = tokio::spawn(async move {
        for (status, reply) in replies {
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
            let authorization = header
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("authorization"))
                        .map(|(_, value)| value.trim().to_string())
                })
                .unwrap_or_default();
            while request.len() - boundary < length {
                let read = stream.read(&mut buffer).await.unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            let mut body =
                parse_json(std::str::from_utf8(&request[boundary..boundary + length]).unwrap())
                    .unwrap();
            if let JsonValue::Object(body) = &mut body {
                body.insert(
                    "_testAuthorization".into(),
                    JsonValue::String(authorization.as_str().into()),
                );
            }
            send.send(body).unwrap();
            let kind = if status == 200 {
                "text/event-stream"
            } else {
                "application/json"
            };
            let response = format!(
                "HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address, receive, task)
}

async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(30), future)
        .await
        .expect("operation did not finish within 30 seconds")
}

fn sse(text: &str) -> String {
    format!(
        "data: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":null}}]}}\n\ndata: {{\"id\":\"reply\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":3,\"completion_tokens\":2}}}}\n\ndata: [DONE]\n\n",
        ycoding_schema::stringify_json(&JsonValue::String(text.into()))
    )
}

fn local(store: &ycoding_store::Store, endpoint: &str) -> Local {
    local_with(store, endpoint, Default::default())
}

fn local_with_skill_resolver(
    store: &ycoding_store::Store,
    endpoint: &str,
    skill_resolver: Arc<dyn Resolver>,
) -> Local {
    local_with_resolver(store, endpoint, Default::default(), Some(skill_resolver))
}

fn pinned(reference: &str) -> helper::Settings {
    helper::Settings {
        compaction_scopes: BTreeMap::from([(
            CompactionScope::Main,
            ModelSelection::Model(
                ycoding_schema::model::Ref::decode(&parse_json(reference).unwrap()).unwrap(),
            ),
        )]),
        ..helper::Settings::default()
    }
}

fn local_with(store: &ycoding_store::Store, endpoint: &str, helpers: helper::Settings) -> Local {
    local_with_resolver(store, endpoint, helpers, None)
}

fn local_with_resolver(
    store: &ycoding_store::Store,
    endpoint: &str,
    helpers: helper::Settings,
    skill_resolver: Option<Arc<dyn Resolver>>,
) -> Local {
    let models =
        include_str!("../../../../packages/core/test/plugin/fixtures/models-dev-reasoning.json")
            .replacen("\"context\": 128000", "\"context\": 6000", 1)
            .replacen(
                "\"models\": {\n      \"gpt-reasoning\": {",
                "\"models\": {\n      \"gpt-helper\": {\"id\":\"gpt-helper\",\"name\":\"GPT Helper\",\"release_date\":\"2026-01-01\",\"attachment\":false,\"reasoning\":false,\"temperature\":true,\"tool_call\":true,\"limit\":{\"context\":20000,\"output\":2000}},\n      \"gpt-reasoning\": {",
                1,
            );
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(&models).unwrap()).unwrap());
    catalog.configure(&[parse_json(&format!(r#"{{"model":{{"providerID":"openai","model":"gpt-reasoning"}},"providers":{{"openai":{{"package":"@ycoding-ai/ai/providers/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#)).unwrap()]).unwrap();
    Local::new(Services {
        snapshots: None,
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog)),
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(store.client()),
        tools: Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &ycoding_core::resources::config::Roots::development(
                    &std::env::temp_dir().join("ycoding-compaction-output"),
                )
                .unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-compaction-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock: Arc::new(WallClock),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: resolve(&[Info {
            context_safety_margin_tokens: Some(1_000),
            ..Info::default()
        }]),
        guardrails: guardrails::guardrails(store),
        helpers,
        cursor: None,
        skill_resolver,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        claude: None,
        auth: None,
    })
}

fn seed_context(store: &ycoding_store::Store) {
    store
        .submit(|tx| {
            RevisionTable::insert(
                tx,
                &Revision {
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
            ContextStateTable::insert(
                tx,
                &ContextState {
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

fn seed_history(store: &ycoding_store::Store, big: String) {
    store
        .submit(move |tx| {
            MessageTable::insert(
                tx,
                &Message {
                    id: "msg_old_user".into(),
                    session_id: "ses_one".into(),
                    type_: "user".into(),
                    seq: 1,
                    time_created: 1,
                    time_updated: 1,
                    data: parse_json(
                        r#"{"text":"Earlier question","time":{"created":1,"consumed":1}}"#,
                    )
                    .unwrap(),
                },
            )?;
            MessageTable::insert(
                tx,
                &Message {
                    id: "msg_old_assistant".into(),
                    session_id: "ses_one".into(),
                    type_: "assistant".into(),
                    seq: 2,
                    time_created: 2,
                    time_updated: 2,
                    data: parse_json(&format!(
                        r#"{{"agent":"build","model":{{"providerID":"openai","id":"gpt-reasoning"}},"content":[{{"type":"text","text":{}}}],"finish":"stop","time":{{"created":2,"completed":2}}}}"#,
                        ycoding_schema::stringify_json(&JsonValue::String(big.as_str().into()))
                    ))
                    .unwrap(),
                },
            )?;
            SequenceTable::put(
                tx,
                &Sequence {
                    aggregate_id: "ses_one".into(),
                    seq: 2,
                    owner_id: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
}

async fn admit(service: &Service, text: &str) {
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_input").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &parse_json(&format!(
                    r#"{{"type":"user","data":{{"text":{}}},"delivery":"steer"}}"#,
                    ycoding_schema::stringify_json(&JsonValue::String(text.into()))
                ))
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_input").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

fn events(store: &ycoding_store::Store) -> Vec<(String, JsonValue)> {
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
        .map(|event| {
            (
                event.record.type_.as_str().unwrap().to_string(),
                event.record.data,
            )
        })
        .collect()
}

fn count(events: &[(String, JsonValue)], kind: &str) -> usize {
    events.iter().filter(|(name, _)| name == kind).count()
}

fn requests_of(
    store: &ycoding_store::Store,
    session: &str,
) -> Vec<ycoding_store::resources::Request> {
    ycoding_store::resources::requests(
        &store.snapshot().unwrap(),
        &session.into(),
        ycoding_store::IndexOrder::Ascending,
        None,
        100,
    )
    .unwrap()
    .into_iter()
    .map(|entry| entry.record)
    .collect()
}

fn helper_reply(through_sequence: i64) -> String {
    sse(&summary_toon::encode(&Memory {
        through_sequence,
        objective: "Preserve HELPER-OBJECTIVE-1".into(),
        in_progress: vec![],
        pending: vec![],
        blocked: vec![],
        decision: vec![],
        skill: vec![],
        requirements: vec![],
        acceptance_criteria: vec![],
        current_state: "Helper state".into(),
        facts: vec![],
        preferences: vec![],
        constraints: vec![],
        completed: vec![],
        unresolved: vec![],
        important_identifiers: vec![],
        continuation: "Continue".into(),
    }))
}

struct SkillFixture(skill::Info);
impl Resolver for SkillFixture {
    fn list(&self) -> SkillsFuture<'_> {
        let skill = self.0.clone();
        Box::pin(async move { Ok(vec![skill]) })
    }

    fn instructions<'a>(&'a self, info: &'a skill::Info) -> InstructionsFuture<'a> {
        Box::pin(async move {
            Ok(format!(
                "<skill_content name=\"{}\">\n{}\n</skill_content>",
                info.name.as_str().unwrap(),
                info.content.as_str().unwrap()
            )
            .into())
        })
    }
}

#[tokio::test]
async fn current_input_skill_is_reactivated_after_completed_compaction_before_request() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(
        &store,
        format!(
            "OLD-HISTORY-MARKER {}",
            "earlier answer detail. ".repeat(1_200)
        ),
    );
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_skill_input").unwrap(),
            session_id: session::Id::new("ses_one").unwrap(),
            input: session_pending::Message::decode(
                &parse_json(r#"{"type":"user","data":{"text":"Use audit","metadata":{"skills":[{"id":"audit"}]}},"delivery":"steer"}"#).unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_skill_input").unwrap(),
            created: 2,
        })
        .await
        .unwrap();
    let info = skill::Info::decode(
        &parse_json(r#"{"id":"audit","name":"Audit","location":"/skills/audit/SKILL.md","content":"REQUIRED-AUDIT-INSTRUCTIONS"}"#).unwrap(),
    )
    .unwrap();
    let (endpoint, mut requests, server) = server(vec![helper_reply(6), sse("Answer")]).await;
    let coordinator = Coordinator::new(Arc::new(local_with_skill_resolver(
        &store,
        &endpoint,
        Arc::new(SkillFixture(info)),
    )));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    let helper = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    let step = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    within(server).await.unwrap();
    assert!(helper.contains("Output exactly one TOON document"));
    assert!(step.contains("REQUIRED-AUDIT-INSTRUCTIONS"));
    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 1);
    assert_eq!(count(&recorded, "session.input.promoted.1"), 1);
    assert_eq!(count(&recorded, "session.skill.activated.1"), 2);
    let statuses = service
        .skills(&session::Id::new("ses_one").unwrap(), &[])
        .unwrap();
    assert_eq!(statuses.len(), 1);
    assert_eq!(
        statuses[0].state,
        ycoding_schema::session_skill_status::State::Active
    );
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_request_over_the_limit_is_compacted_through_a_hidden_helper_before_the_step_request() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(
        &store,
        format!(
            "OLD-HISTORY-MARKER {}",
            "earlier answer detail. ".repeat(1_200)
        ),
    );
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) = server(vec![helper_reply(6), sse("Answer")]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    let helper = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    let step = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    within(server).await.unwrap();
    assert!(helper.contains("Output exactly one TOON document"));
    assert!(helper.contains("up to and including 6"));
    assert!(!helper.contains("\"tools\""));
    assert!(step.contains("<conversation-checkpoint>"));
    assert!(step.contains("HELPER-OBJECTIVE-1"));
    assert!(step.contains("Answer the prompt"));
    assert!(!step.contains(&"earlier answer detail. ".repeat(60)));
    assert!(step.len() < 6_000);

    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.compaction.admitted.2"), 1);
    assert_eq!(count(&recorded, "session.compaction.started.2"), 1);
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 1);
    assert_eq!(count(&recorded, "session.step.started.1"), 1);
    let state = store
        .snapshot()
        .unwrap()
        .get::<ContextStateTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap();
    assert_eq!(state.revision, 1);

    let job = recorded
        .iter()
        .find(|(name, _)| name == "session.compaction.admitted.2")
        .map(|(_, data)| ycoding_schema::stringify_json(data))
        .unwrap();
    let job_id = job
        .split("\"jobID\":\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let child = format!(
        "ses_compaction_{}",
        &ycoding_core::session::prompt_cache::sha256(job_id)[..24]
    );
    let child_info = service
        .get(&session::Id::new(child.clone()).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(
        child_info.parent_id,
        Some(session::Id::new("ses_one").unwrap())
    );
    let helper_requests = requests_of(&store, &child);
    assert_eq!(helper_requests.len(), 1);
    assert_eq!(helper_requests[0].source.as_str(), Some("compaction"));
    let owner_requests = requests_of(&store, "ses_one");
    assert_eq!(owner_requests.len(), 1);
    assert_eq!(owner_requests[0].source.as_str(), Some("step"));
    coordinator.shutdown().await.unwrap();
}

fn activated_manifest(store: &ycoding_store::Store) -> context_manifest::Manifest {
    let snapshot = store.snapshot().unwrap();
    let state = snapshot
        .get::<ContextStateTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&"ses_one".into()),
        ]))
        .unwrap()
        .unwrap();
    let row = snapshot
        .get::<ManifestTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&state.manifest_digest.unwrap()),
        ]))
        .unwrap()
        .unwrap();
    context_manifest::parse_manifest(row.content.value()).unwrap()
}

#[tokio::test]
async fn the_activated_manifest_protects_the_live_state_and_the_summary_retains_its_text() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(
        &store,
        format!("OLD-MARKER {}", "earlier answer detail. ".repeat(1_200)),
    );
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) = server(vec![helper_reply(2), sse("Answer")]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    within(requests.recv()).await.unwrap();
    within(requests.recv()).await.unwrap();
    within(server).await.unwrap();

    let manifest = activated_manifest(&store);
    assert_eq!(
        manifest
            .protected_state
            .iter()
            .map(|entry| entry.source.as_str())
            .collect::<Vec<_>>(),
        [
            "autonomy",
            "goal",
            "guardrails",
            "instructions",
            "orchestration",
            "pending_work",
            "permissions",
            "todos"
        ]
    );
    assert!(
        manifest
            .protected_state
            .iter()
            .all(|entry| entry.digest.to_utf8().unwrap().len() == 64)
    );
    assert!(
        manifest
            .summary
            .unwrap()
            .text
            .to_utf8()
            .unwrap()
            .contains("Authoritative current Session state (JSON):")
    );
    coordinator.shutdown().await.unwrap();
}

fn wire_field(body: &JsonValue, name: &str) -> String {
    let JsonValue::Object(body) = body else {
        panic!("request body is not an object")
    };
    match body.get(&name.into()) {
        Some(JsonValue::String(value)) => value.to_utf8().unwrap(),
        other => panic!("request body has no {name}: {other:?}"),
    }
}

fn helper_session_of(recorded: &[(String, JsonValue)]) -> session::Id {
    let job = recorded
        .iter()
        .find(|(name, _)| name == "session.compaction.admitted.2")
        .map(|(_, data)| ycoding_schema::stringify_json(data))
        .unwrap();
    let job_id = job
        .split("\"jobID\":\"")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    session::Id::new(format!(
        "ses_compaction_{}",
        &ycoding_core::session::prompt_cache::sha256(job_id)[..24]
    ))
    .unwrap()
}

async fn compact_with(
    store: &ycoding_store::Store,
    helpers: helper::Settings,
    replies: Vec<String>,
) -> (Vec<JsonValue>, Vec<(String, JsonValue)>) {
    let service = Service::new(store.client());
    seed_context(store);
    seed_history(
        store,
        format!("OLD-MARKER {}", "earlier answer detail. ".repeat(1_200)),
    );
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) = server(replies).await;
    let coordinator = Coordinator::new(Arc::new(local_with(store, &endpoint, helpers)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    within(server).await.unwrap();
    coordinator.shutdown().await.unwrap();
    let mut received = Vec::new();
    while let Ok(body) = requests.try_recv() {
        received.push(body);
    }
    (received, events(store))
}

#[tokio::test]
async fn a_pinned_compaction_model_runs_the_helper_on_that_model_and_leaves_the_step_model() {
    let store = support::store();
    let (requests, recorded) = compact_with(
        &store,
        pinned(r#"{"providerID":"openai","id":"gpt-helper"}"#),
        vec![helper_reply(2), sse("Answer")],
    )
    .await;
    let [helper, step] = requests.as_slice() else {
        panic!("expected a helper request and a step request")
    };
    assert_eq!(wire_field(helper, "model"), "gpt-helper");
    assert_eq!(wire_field(step, "model"), "gpt-reasoning");
    assert!(ycoding_schema::stringify_json(step).contains("<conversation-checkpoint>"));

    let child = Service::new(store.client())
        .get(&helper_session_of(&recorded))
        .unwrap()
        .unwrap();
    let selected = ycoding_schema::stringify_json(&ycoding_schema::DomainEncode::encode(
        &child.model.unwrap(),
    ));
    assert!(selected.contains("\"id\":\"gpt-helper\""));
}

#[tokio::test]
async fn a_pinned_compaction_profile_binds_the_helper_session_to_its_own_credential() {
    let store = support::store();
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
    let work = credentials
        .create(
            "cred_work".into(),
            "openai".into(),
            Some("Work".into()),
            key("fixture-work-key"),
            1,
        )
        .await
        .unwrap();
    let personal = credentials
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
                parse_json(r#"{"providerID":"openai","id":"gpt-reasoning","profile":"Personal"}"#)
                    .unwrap(),
            )?);
            ycoding_store::session::SessionTable::put(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    let (requests, recorded) = compact_with(
        &store,
        pinned(r#"{"providerID":"openai","id":"gpt-helper","profile":"Work"}"#),
        vec![helper_reply(2), sse("Answer")],
    )
    .await;
    let [helper, step] = requests.as_slice() else {
        panic!("expected a helper request and a step request")
    };
    assert_eq!(
        wire_field(helper, "_testAuthorization"),
        "Bearer fixture-work-key"
    );
    assert_eq!(
        wire_field(step, "_testAuthorization"),
        "Bearer fixture-personal-key"
    );

    let service = Service::new(store.client());
    let helper_binding = service
        .profile_binding(&helper_session_of(&recorded))
        .unwrap()
        .unwrap();
    assert_eq!(helper_binding.credential_id.0, *work.id());
    let owner_binding = service
        .profile_binding(&session::Id::new("ses_one").unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(owner_binding.credential_id.0, *personal.id());
    credentials.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_unresolvable_compaction_model_falls_back_to_the_deterministic_summary_without_a_helper()
{
    let store = support::store();
    let (requests, recorded) = compact_with(
        &store,
        pinned(r#"{"providerID":"openai","id":"gpt-missing"}"#),
        vec![sse("Answer")],
    )
    .await;
    let [step] = requests.as_slice() else {
        panic!("expected only the step request")
    };
    assert_eq!(wire_field(step, "model"), "gpt-reasoning");
    assert!(ycoding_schema::stringify_json(step).contains("<conversation-checkpoint>"));
    assert!(!ycoding_schema::stringify_json(step).contains("HELPER-OBJECTIVE-1"));
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 1);
}

#[tokio::test]
async fn a_request_with_no_reducible_history_is_not_compacted() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    admit(&service, &"unreducible current request. ".repeat(1_000)).await;
    let (endpoint, mut requests, server) = server(vec![sse("Answer")]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    within(requests.recv()).await.unwrap();
    within(server).await.unwrap();
    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.compaction.admitted.2"), 0);
    assert_eq!(count(&recorded, "session.step.ended.1"), 1);
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_request_under_the_limit_is_sent_without_compaction() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(&store, "short earlier answer".into());
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) = server(vec![sse("Answer")]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    let step = ycoding_schema::stringify_json(&within(requests.recv()).await.unwrap());
    within(server).await.unwrap();
    assert!(step.contains("short earlier answer"));
    assert_eq!(count(&events(&store), "session.compaction.admitted.2"), 0);
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_already_pending_job_is_settled_by_the_gate_instead_of_admitting_another() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(
        &store,
        format!("OLD-MARKER {}", "earlier answer detail. ".repeat(1_200)),
    );
    admit(&service, "Answer the prompt").await;
    let existing = service
        .compaction_admit(
            AdmitInput {
                id: None,
                session: session::Id::new("ses_one").unwrap(),
                trigger: session_compaction::Trigger::Mandatory,
                requested_through_message: session_message::Id::new("msg_old_assistant").unwrap(),
                requested_through_seq: 2,
                base_context_revision: 0,
                target_max_input_tokens: 4_200,
                config_digest: "c".repeat(64),
                pressure: None,
            },
            1,
        )
        .await
        .unwrap();
    let (endpoint, mut requests, server) = server(vec![helper_reply(2), sse("Answer")]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    let helper = text_of(within(requests.recv()).await.unwrap());
    let step = text_of(within(requests.recv()).await.unwrap());
    within(server).await.unwrap();
    assert!(helper.contains("Output exactly one TOON document"));
    assert!(step.contains("<conversation-checkpoint>"));
    assert!(!step.contains(&"earlier answer detail. ".repeat(60)));

    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.compaction.admitted.2"), 1);
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 1);
    let ended = recorded
        .iter()
        .find(|(name, _)| name == "session.compaction.ended.2")
        .map(|(_, data)| text_of(data.clone()))
        .unwrap();
    assert!(ended.contains(&text_of(JsonValue::String(existing.id.clone()))));
    coordinator.shutdown().await.unwrap();
}

fn overflow() -> (u16, String) {
    (
        400,
        r#"{"error":{"message":"This model's maximum context length is 6000 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}"#.into(),
    )
}

fn text_of(value: JsonValue) -> String {
    ycoding_schema::stringify_json(&value)
}

#[tokio::test]
async fn a_provider_context_overflow_rebuilds_the_same_step_once_after_a_forced_compaction() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(
        &store,
        format!("OLD-MARKER {}", "earlier answer detail. ".repeat(600)),
    );
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) = scripted(vec![
        overflow(),
        (200, helper_reply(6)),
        (200, sse("Answer")),
    ])
    .await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    within(coordinator.run(&session::Id::new("ses_one").unwrap()))
        .await
        .unwrap();
    let first = text_of(within(requests.recv()).await.unwrap());
    let helper = text_of(within(requests.recv()).await.unwrap());
    let second = text_of(within(requests.recv()).await.unwrap());
    within(server).await.unwrap();
    assert!(first.contains("OLD-MARKER"));
    assert!(!first.contains("<conversation-checkpoint>"));
    assert!(helper.contains("Output exactly one TOON document"));
    assert!(second.contains("<conversation-checkpoint>"));
    assert!(second.contains("HELPER-OBJECTIVE-1"));
    assert!(second.contains("Answer the prompt"));
    assert!(!second.contains(&"earlier answer detail. ".repeat(60)));
    assert!(second.len() < first.len());

    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.step.started.1"), 1);
    assert_eq!(count(&recorded, "session.step.ended.1"), 1);
    assert_eq!(count(&recorded, "session.step.failed.1"), 0);
    assert_eq!(count(&recorded, "session.compaction.admitted.2"), 1);
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 1);
    let owner = requests_of(&store, "ses_one");
    assert_eq!(owner.len(), 1);
    assert_eq!(owner[0].attempts, 2);
    assert_eq!(owner[0].request, 1);
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_second_context_overflow_after_the_rebuild_fails_the_step_without_a_third_attempt() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(
        &store,
        format!("OLD-MARKER {}", "earlier answer detail. ".repeat(600)),
    );
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) =
        scripted(vec![overflow(), (200, helper_reply(2)), overflow()]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    let outcome = within(coordinator.run(&session::Id::new("ses_one").unwrap())).await;
    assert!(outcome.is_err());
    within(server).await.unwrap();
    for _ in 0..3 {
        within(requests.recv()).await.unwrap();
    }
    assert!(requests.try_recv().is_err());

    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.step.started.1"), 1);
    assert_eq!(count(&recorded, "session.step.ended.1"), 0);
    assert_eq!(count(&recorded, "session.step.failed.1"), 1);
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 1);
    let failed = recorded
        .iter()
        .find(|(name, _)| name == "session.step.failed.1")
        .map(|(_, data)| text_of(data.clone()))
        .unwrap();
    assert!(failed.contains("\"type\":\"context.limit\""));
    assert!(failed.contains(
        "The provider still rejected the request for context overflow after one compaction rebase"
    ));
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_failed_forced_compaction_still_allows_exactly_one_more_attempt() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    seed_history(&store, "short earlier answer".into());
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) =
        scripted(vec![overflow(), (200, helper_reply(2)), overflow()]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    let outcome = within(coordinator.run(&session::Id::new("ses_one").unwrap())).await;
    assert!(outcome.is_err());
    within(server).await.unwrap();
    for _ in 0..3 {
        within(requests.recv()).await.unwrap();
    }
    assert!(requests.try_recv().is_err());

    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.compaction.failed.2"), 1);
    assert_eq!(count(&recorded, "session.compaction.ended.2"), 0);
    assert_eq!(count(&recorded, "session.step.started.1"), 1);
    assert_eq!(count(&recorded, "session.step.failed.1"), 1);
    let failed = recorded
        .iter()
        .find(|(name, _)| name == "session.step.failed.1")
        .map(|(_, data)| text_of(data.clone()))
        .unwrap();
    assert!(failed.contains("\"type\":\"context.limit\""));
    assert!(failed.contains("after one compaction rebase"));
    coordinator.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_context_overflow_with_nothing_to_reduce_fails_the_step_without_compacting() {
    let store = support::store();
    let service = Service::new(store.client());
    seed_context(&store);
    admit(&service, "Answer the prompt").await;
    let (endpoint, mut requests, server) = scripted(vec![overflow()]).await;
    let coordinator = Coordinator::new(Arc::new(local(&store, &endpoint)));
    let outcome = within(coordinator.run(&session::Id::new("ses_one").unwrap())).await;
    assert!(outcome.is_err());
    within(server).await.unwrap();
    within(requests.recv()).await.unwrap();
    assert!(requests.try_recv().is_err());

    let recorded = events(&store);
    assert_eq!(count(&recorded, "session.step.started.1"), 1);
    assert_eq!(count(&recorded, "session.step.failed.1"), 1);
    assert_eq!(count(&recorded, "session.compaction.admitted.2"), 0);
    coordinator.shutdown().await.unwrap();
}
