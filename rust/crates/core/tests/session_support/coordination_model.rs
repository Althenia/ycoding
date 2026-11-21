use super::*;
use std::time::Duration;
use ycoding_core::{
    coordination::{
        self,
        runtime::{
            DecisionEscalateInput, DecisionEscalateResult, DecisionResult, Decisions,
            EvaluateInput, Future as RuntimeFuture, Options, Pending, PendingInput, Runtime,
            SendInput,
        },
    },
    event_feed::Feed,
    session::{
        execution::{Execution, Locations},
        run_coordinator,
    },
};
use ycoding_schema::{
    coordination as c,
    credential::{Key, Value},
    model as model_schema,
};
use ycoding_store::session::{EventTable, Session as SessionRow, SessionTable};

const CHAT: &str = r#"{"openai":{"id":"openai","name":"Fixture","env":[],"npm":"@ai-sdk/openai-compatible","api":"https://example.test/v1","models":{"chat-a":{"id":"chat-a","name":"A","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192}},"chat-b":{"id":"chat-b","name":"B","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"modalities":{"input":["text"],"output":["text"]},"limit":{"context":128000,"output":8192}}}}}"#;

struct Placed(Local);

impl Locations for Placed {
    fn get(
        &self,
        _session: &ycoding_schema::session::Info,
    ) -> Result<Arc<dyn Runner>, run_coordinator::Error> {
        Ok(Arc::new(self.0.clone()))
    }
}

struct Refused;

impl Decisions for Refused {
    fn settings(&self) -> RuntimeFuture<'_, c::Settings> {
        Box::pin(async {
            Ok(c::Settings {
                enabled: false,
                categories: vec![],
                actions: None,
                resources: None,
                expires_at: None,
            })
        })
    }
    fn pending(&self, _input: PendingInput) -> RuntimeFuture<'_, Vec<Pending>> {
        Box::pin(async { Ok(vec![]) })
    }
    fn evaluate(&self, _input: EvaluateInput) -> RuntimeFuture<'_, DecisionResult> {
        Box::pin(async { Err(coordination::Error::refused("not part of this fixture")) })
    }
    fn escalate(&self, _input: DecisionEscalateInput) -> RuntimeFuture<'_, DecisionEscalateResult> {
        Box::pin(async { Err(coordination::Error::refused("not part of this fixture")) })
    }
}

fn reference(id: &str, profile: Option<&str>) -> model_schema::Ref {
    selected(id, None, profile)
}

fn selected(id: &str, variant: Option<&str>, profile: Option<&str>) -> model_schema::Ref {
    let mut value = format!(r#"{{"providerID":"openai","id":"{id}""#);
    if let Some(variant) = variant {
        value.push_str(&format!(r#","variant":"{variant}""#));
    }
    if let Some(profile) = profile {
        value.push_str(&format!(r#","profile":"{profile}""#));
    }
    value.push('}');
    model_schema::Ref::decode(&parse_json(&value).unwrap()).unwrap()
}

fn member(id: &str, model: &model_schema::Ref) -> SessionRow {
    let mut row = support::record(id);
    row.model = Some(ycoding_store::session::Document::from_domain(model).unwrap());
    row
}

fn event_types(store: &ycoding_store::Store, id: &str) -> Vec<String> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&id.into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<EventTable>(
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

fn stored(store: &ycoding_store::Store, id: &str) -> SessionRow {
    store
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&ycoding_store::tuple_key(&[
            ycoding_store::KeyPart::String(&id.into()),
        ]))
        .unwrap()
        .unwrap()
}

fn unchanged(store: &ycoding_store::Store, id: &str, before: &SessionRow) {
    let after = stored(store, id);
    assert_eq!(
        after.model, before.model,
        "{id}: the persisted model stays untouched"
    );
    assert_eq!(
        after.profile_binding, before.profile_binding,
        "{id}: the persisted profile binding stays untouched"
    );
}

async fn request(
    requests: &mut mpsc::UnboundedReceiver<ycoding_schema::JsonValue>,
) -> serde_json::Value {
    let body = tokio::time::timeout(Duration::from_secs(10), requests.recv())
        .await
        .expect("the provider request must arrive within 10s")
        .unwrap();
    serde_json::from_str(&ycoding_schema::stringify_json(&body)).unwrap()
}

async fn terminal(store: &ycoding_store::Store, id: &str, kind: &str, count: usize) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while event_types(store, id)
        .iter()
        .filter(|seen| *seen == kind)
        .count()
        < count
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{id} never recorded {count} {kind}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn master_send_model_applies_to_the_turn_only_and_never_rebinds_the_member() {
    let store = support::store();
    let a = reference("chat-a", None);
    let work = reference("chat-a", Some("work"));
    let gone = reference("chat-gone", None);
    store
        .submit({
            let (a, work, gone) = (a.clone(), work.clone(), gone.clone());
            move |tx| {
                SessionTable::put(tx, &member("ses_two", &a))?;
                SessionTable::insert(tx, &member("ses_three", &work))?;
                SessionTable::insert(tx, &member("ses_four", &gone))?;
                SessionTable::insert(tx, &member("ses_five", &gone))
            }
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Service::new(store.client());
    let projects = coordination::Service::new(store.client(), Feed::attach(&store.client()));
    let group = projects
        .create(c::CreateInput {
            name: "Override".into(),
            master_session_id: session::Id::new("ses_one").unwrap(),
            member_session_ids: vec![
                session::Id::new("ses_two").unwrap(),
                session::Id::new("ses_three").unwrap(),
                session::Id::new("ses_four").unwrap(),
                session::Id::new("ses_five").unwrap(),
            ],
        })
        .await
        .unwrap();
    projects.activate(&group.id).unwrap();

    let secret = ycoding_store::resources::Secret::new(
        Value::Key(Key {
            key: "fixture-secret".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap();
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "cred_work".into(),
            "openai".into(),
            Some("work".into()),
            secret.clone(),
            1,
        )
        .await
        .unwrap();
    let (_, binding) = credentials
        .resolve_session(&"ses_three".into(), &"openai".into(), false)
        .unwrap()
        .unwrap();
    credentials
        .publish_binding("ses_three".into(), "evt_bind_work".into(), Some(binding), 2)
        .await
        .unwrap();
    let mut plain = stored(&store, "ses_three");
    plain.model = Some(ycoding_store::session::Document::from_domain(&a).unwrap());
    store
        .submit(move |tx| SessionTable::put(tx, &plain))
        .unwrap()
        .wait()
        .unwrap();
    assert!(stored(&store, "ses_three").profile_binding.is_some());

    let (endpoint, mut requests, server) = server(vec![TEXT, TEXT, TEXT, TEXT]).await;
    let mut catalog = Catalog::new(models_dev::normalize(&parse_json(CHAT).unwrap()).unwrap());
    catalog
        .configure(&[
            parse_json(&format!(
                r#"{{"model":{{"providerID":"openai","model":"chat-a"}},"providers":{{"openai":{{"package":"@ai-sdk/openai-compatible","settings":{{"apiKey":"fixture","baseURL":"{endpoint}"}}}}}}}}"#
            ))
            .unwrap(),
            parse_json(
                r#"{"providers":{"openai":{"models":{"chat-b":{"variants":[{"id":"careful","headers":{"x-fixture-variant":"careful"}}]}}}}}"#,
            )
            .unwrap(),
        ])
        .unwrap();
    let local = local_services(
        &store,
        catalog,
        vec![agent::empty("build".into())],
        registry(),
        Arc::new(WallClock),
        Vec::new(),
    );
    let execution = Execution::install(
        service.clone(),
        Arc::new(Placed(local)),
        ycoding_core::job::Jobs::new(),
        None,
    )
    .unwrap();
    let runtime = Runtime::new(Options {
        coordination: projects.clone(),
        sessions: service.clone(),
        execution,
        decisions: Arc::new(Refused),
        jobs: execution.jobs().clone(),
        validate_model: Arc::new(|_, _| Box::pin(async { Ok(()) })),
        model_services: Arc::new(|_| {
            Box::pin(async {
                Err(coordination::Error::refused(
                    "model switching is outside this send fixture",
                ))
            })
        }),
        creator: None,
    });
    let master = session::Id::new("ses_one").unwrap();
    let two = session::Id::new("ses_two").unwrap();
    let three = session::Id::new("ses_three").unwrap();
    let before = stored(&store, "ses_two");

    runtime
        .send(
            &master,
            SendInput {
                session_id: two.clone(),
                text: "Run the focused checks".into(),
                delivery: None,
                message_id: None,
                model: Some(reference("chat-b", None)),
            },
        )
        .await
        .unwrap();
    let first = request(&mut requests).await;
    assert_eq!(first["model"], "chat-b", "{first}");
    assert!(first.to_string().contains("Run the focused checks"));
    terminal(&store, "ses_two", "session.execution.succeeded.1", 1).await;
    execution.await_idle(&two).await;
    unchanged(&store, "ses_two", &before);

    runtime
        .send(
            &master,
            SendInput {
                session_id: two.clone(),
                text: "Run with the work profile".into(),
                delivery: None,
                message_id: None,
                model: Some(selected("chat-b", Some("careful"), Some("work"))),
            },
        )
        .await
        .unwrap();
    let profiled = request(&mut requests).await;
    assert_eq!(profiled["model"], "chat-b", "{profiled}");
    assert_eq!(
        profiled["_testVariant"], "careful",
        "the selected variant's settings must reach the request: {profiled}"
    );
    assert_eq!(
        profiled["_testAuthorization"], "Bearer fixture-secret",
        "the selected profile's credential must authorize the request: {profiled}"
    );
    terminal(&store, "ses_two", "session.execution.succeeded.1", 2).await;
    execution.await_idle(&two).await;
    unchanged(&store, "ses_two", &before);

    execution
        .prompt(
            ycoding_core::session::pending::Request {
                id: session_message::Id::new("msg_plain").unwrap(),
                session_id: two.clone(),
                input: session_pending::Message::decode(
                    &parse_json(
                        r#"{"type":"user","data":{"text":"Plain follow-up"},"delivery":"queue"}"#,
                    )
                    .unwrap(),
                )
                .unwrap(),
                event_id: ycoding_schema::event::Id::new("evt_plain").unwrap(),
                created: 3,
            },
            None,
        )
        .await
        .unwrap();
    let second = request(&mut requests).await;
    assert_eq!(
        second["model"], "chat-a",
        "an ordinary user message uses the persisted model: {second}"
    );
    terminal(&store, "ses_two", "session.execution.succeeded.1", 3).await;
    execution.await_idle(&two).await;
    unchanged(&store, "ses_two", &before);

    credentials
        .create(
            "cred_unused".into(),
            "openai".into(),
            Some("work".into()),
            secret,
            3,
        )
        .await
        .unwrap();
    let rotated = stored(&store, "ses_three");
    runtime
        .send(
            &master,
            SendInput {
                session_id: three.clone(),
                text: "Use the rotated profile".into(),
                delivery: None,
                message_id: None,
                model: Some(reference("chat-b", Some("work"))),
            },
        )
        .await
        .unwrap();
    terminal(&store, "ses_three", "session.execution.failed.1", 1).await;
    execution.await_idle(&three).await;
    assert!(
        requests.try_recv().is_err(),
        "a rotated same-label credential must fail closed before any provider request"
    );
    unchanged(&store, "ses_three", &rotated);

    let four = session::Id::new("ses_four").unwrap();
    let five = session::Id::new("ses_five").unwrap();
    let unavailable = stored(&store, "ses_four");
    runtime
        .send(
            &master,
            SendInput {
                session_id: four.clone(),
                text: "Recover through the override".into(),
                delivery: None,
                message_id: None,
                model: Some(reference("chat-b", None)),
            },
        )
        .await
        .unwrap();
    let recovered = request(&mut requests).await;
    assert_eq!(
        recovered["model"], "chat-b",
        "a valid override must run although the persisted model is unavailable: {recovered}"
    );
    terminal(&store, "ses_four", "session.execution.succeeded.1", 1).await;
    execution.await_idle(&four).await;
    unchanged(&store, "ses_four", &unavailable);

    let unavailable = stored(&store, "ses_five");
    runtime
        .send(
            &master,
            SendInput {
                session_id: five.clone(),
                text: "Both models are unavailable".into(),
                delivery: None,
                message_id: None,
                model: Some(reference("chat-void", None)),
            },
        )
        .await
        .unwrap();
    terminal(&store, "ses_five", "session.execution.failed.1", 1).await;
    execution.await_idle(&five).await;
    assert!(
        requests.try_recv().is_err(),
        "an unavailable override must not fall back to any other model"
    );
    unchanged(&store, "ses_five", &unavailable);

    execution.shutdown().await.unwrap();
    server.await.unwrap();
}
