use std::{path::PathBuf, sync::Arc};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        credential, model,
    },
    session::{
        runner::{Clock, Local, Services},
        store::Service,
    },
    tools::registry::Registry,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, session, session_message, session_pending,
};

#[path = "../session_support/guardrails.rs"]
mod existing_guardrails;
#[path = "../session_support/record.rs"]
mod existing_record;

pub fn store() -> ycoding_store::Store {
    let store = ycoding_store::Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::import::catalog(ycoding_store::import::DatabaseKind::Core),
        ycoding_store::Metadata::new([7; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "prj_one".into(),
                    worktree: "/project".into(),
                    vcs: None,
                    name: None,
                    icon_url: None,
                    icon_url_override: None,
                    icon_color: None,
                    time_created: 1,
                    time_updated: 1,
                    time_initialized: None,
                    sandboxes: Vec::new(),
                    commands: None,
                },
            )?;
            for id in ["ses_one", "ses_two"] {
                ycoding_store::session::SessionTable::insert(tx, &existing_record::record(id))?;
                ycoding_store::session::RevisionTable::insert(
                    tx,
                    &ycoding_store::session::Revision {
                        session_id: id.into(),
                        revision: 0,
                        parent_revision: None,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activation_event_id: None,
                        activation_sequence: None,
                        time_created: 1,
                    },
                )?;
                ycoding_store::session::ContextStateTable::insert(
                    tx,
                    &ycoding_store::session::ContextState {
                        session_id: id.into(),
                        status: "active".into(),
                        revision: 0,
                        manifest_digest: None,
                        covered_through_message_id: None,
                        covered_through_seq: None,
                        activated_event_id: None,
                        time_activated: None,
                        error_code: None,
                    },
                )?;
            }
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

pub struct Root(PathBuf);
impl Root {
    pub fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ycoding-provider-contract-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[derive(Default)]
pub struct ClockControl {
    pub delays: std::sync::Mutex<Vec<u64>>,
    elapsed: Arc<std::sync::atomic::AtomicU64>,
}
impl ClockControl {
    pub fn advance(&self, milliseconds: u64) {
        self.elapsed
            .fetch_add(milliseconds, std::sync::atomic::Ordering::SeqCst);
    }
}
impl Clock for ClockControl {
    fn now(&self) -> i64 {
        1_791_900_000_000 + self.elapsed.load(std::sync::atomic::Ordering::SeqCst) as i64
    }
    fn sleep(
        &self,
        milliseconds: u64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        self.delays.lock().unwrap().push(milliseconds);
        let elapsed = self.elapsed.clone();
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
            elapsed.fetch_add(milliseconds, std::sync::atomic::Ordering::SeqCst);
        })
    }
}

pub fn catalog(base: &str, api_model: &str) -> Catalog {
    let source = serde_json::json!({"openai": {
        "id":"openai","name":"OpenAI","env":[],"npm":"@ai-sdk/openai-compatible",
        "models": {"selected": {"id": api_model,"name":"Selected","release_date":"2026-01-01",
            "attachment":true,"reasoning":true,"tool_call":true,
            "modalities":{"input":["text","image"],"output":["text"]},
            "limit":{"context":128000,"output":8192}}}
    }});
    let mut catalog =
        Catalog::new(models_dev::normalize(&parse_json(&source.to_string()).unwrap()).unwrap());
    catalog.configure(&[parse_json(&serde_json::json!({
        "model":{"providerID":"openai","model":"selected"},
        "providers":{"openai":{"package":"@ycoding-ai/ai/providers/openai-compatible",
            "settings":{"baseURL":format!("{base}/v1")},
            "models":{"selected":{"modelID":api_model,"variants":[{"id":"high","settings":{"providerOptions":{"openai":{"reasoningEffort":"high"}}}}]}}}}
    }).to_string()).unwrap()]).unwrap();
    catalog
}

pub fn local(
    store: &ycoding_store::Store,
    models: Arc<model::Resolver>,
    directory: &str,
    root: &Root,
    executor: Arc<ycoding_ai::route::Executor>,
    clock: Arc<ClockControl>,
) -> Local {
    Local::new(services(store, models, directory, root, executor, clock))
}

pub fn services(
    store: &ycoding_store::Store,
    models: Arc<model::Resolver>,
    directory: &str,
    root: &Root,
    executor: Arc<ycoding_ai::route::Executor>,
    clock: Arc<ClockControl>,
) -> Services {
    Services {
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(&serde_json::json!({"directory":directory}).to_string()).unwrap(),
        )
        .unwrap(),
        models,
        agents: Arc::new(agent::Service::new(vec![agent::empty("build".into())])),
        credentials: credential::Service::new(store.client()),
        tools: Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &ycoding_core::resources::config::Roots::development(root.path()).unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(
            attachment_store::Store::new(root.path().join("attachments")).unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock,
        executor,
        compaction: Default::default(),
        guardrails: existing_guardrails::guardrails(store),
        helpers: Default::default(),
        cursor: None,
        claude: None,
        auth: None,
        skill_resolver: None,
        snapshots: None,
        configuration: None,
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
    }
}

pub fn key(value: &str) -> ycoding_store::resources::Secret {
    ycoding_store::resources::Secret::new(
        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: value.into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

pub async fn select(
    service: &Service,
    id: &str,
    profile: Option<&str>,
    variant: Option<&str>,
    serial: usize,
) {
    service
        .publish(ycoding_store::session::NewEvent {
            id: format!("evt_selection_{serial}").into(),
            aggregate_id: id.into(),
            created: serial as i64 + 10,
            type_: "session.model.selected.1".into(),
            data: ycoding_schema::ObjectEncoder::new()
                .field("sessionID", id)
                .field(
                    "model",
                    &ycoding_schema::model::Ref {
                        provider_id: ycoding_schema::provider::Id("openai".into()),
                        id: "selected".into(),
                        profile: profile
                            .map(|profile| ycoding_schema::model::ProfileName(profile.into())),
                        variant: variant.map(Into::into),
                    }
                    .encode(),
                )
                .finish(),
        })
        .await
        .unwrap();
}

pub async fn admit(service: &Service, id: &str, serial: usize, text: &str) {
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new(format!("msg_prompt_{serial}")).unwrap(),
            session_id: session::Id::new(id).unwrap(),
            input: session_pending::Message::decode(
                &parse_json(
                    &serde_json::json!({"type":"user","data":{"text":text},"delivery":"steer"})
                        .to_string(),
                )
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new(format!("evt_prompt_{serial}")).unwrap(),
            created: serial as i64 + 20,
        })
        .await
        .unwrap();
}

pub fn requests(store: &ycoding_store::Store, id: &str) -> Vec<ycoding_store::resources::Request> {
    ycoding_store::resources::requests(
        &store.snapshot().unwrap(),
        &id.into(),
        ycoding_store::IndexOrder::Ascending,
        None,
        100,
    )
    .unwrap()
    .into_iter()
    .map(|row| row.record)
    .collect()
}

pub fn events(store: &ycoding_store::Store, id: &str) -> Vec<String> {
    store
        .snapshot()
        .unwrap()
        .index_range::<ycoding_store::session::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                prefix: Some(&ycoding_store::tuple_key(&[
                    ycoding_store::KeyPart::String(&id.into()),
                ])),
                lower: std::ops::Bound::Unbounded,
                upper: std::ops::Bound::Unbounded,
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|row| row.record.type_.to_utf8().unwrap())
        .collect()
}

pub fn field<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    let JsonValue::Object(fields) = value else {
        return None;
    };
    fields.get(&key.into())
}

pub fn entrypoint(
    package: &str,
    saved: &[credential::Info],
    profile: Option<&str>,
    variant: Option<&str>,
    transport: Option<&str>,
) -> ycoding_ai::route::Prepared {
    let mut catalog = Catalog::default();
    let mut document = serde_json::json!({"providers":{"local":{"package":package,"settings":{"apiKey":"synthetic-key","baseURL":"http://127.0.0.1:1/v1"},"models":{"contract":{"variants":[{"id":"high","body":{"metadata":{"variant":"high"}}}]}}}}});
    if let Some(transport) = transport {
        document["providers"]["local"]["settings"]["transport"] = transport.into();
    }
    catalog
        .configure(&[parse_json(&document.to_string()).unwrap()])
        .unwrap();
    let selected = saved.iter().find(|credential| {
        profile.map_or_else(
            || credential.active(),
            |profile| credential.label().as_str() == Some(profile),
        )
    });
    let resolved = model::Resolver::new(catalog)
        .resolve(
            &ycoding_schema::model::Ref {
                provider_id: ycoding_schema::provider::Id("local".into()),
                id: "contract".into(),
                variant: variant.map(Into::into),
                profile: profile.map(|profile| ycoding_schema::model::ProfileName(profile.into())),
            },
            saved,
            selected,
        )
        .unwrap();
    let native = model::from_catalog_model(
        &resolved.info,
        selected
            .map(|credential| credential.secret().domain().unwrap())
            .as_ref(),
    )
    .unwrap();
    let mut request = ycoding_ai::llm::Request::new(native.clone());
    request
        .messages
        .push(ycoding_ai::llm::Message::user("Entrypoint contract"));
    native.route.prepare(&request).unwrap()
}

pub fn chat(usage: &str) -> String {
    format!(
        "data: {{\"id\":\"fixture\",\"choices\":[{{\"index\":0,\"delta\":{{\"thought\":\"plan\",\"content\":\"answer\"}}}}]}}\n\ndata: {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}]{usage}}}\n\ndata: [DONE]\n\n"
    )
}
