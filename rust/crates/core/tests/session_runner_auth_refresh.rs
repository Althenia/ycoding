use std::{
    ops::Bound,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use ycoding_core::{
    resources::{
        agent, attachment_store,
        catalog::{Catalog, models_dev},
        config::{Configuration, LoadOptions, Roots},
        credential, model,
    },
    session::{
        run_coordinator::{Coordinator, Error},
        runner::{Clock, Local, Services},
        store::Service,
    },
    tools::registry::Registry,
};
use ycoding_schema::{
    DomainDecode, DomainEncode, JsonValue, parse_json, session, session_message, session_pending,
};
use ycoding_store::{
    Store, TableDeclaration, analytics, model_incident, project,
    resources::{self, Secret},
    session::{self as tables},
};

#[path = "session_support/guardrails.rs"]
mod guardrails;
#[path = "session_support/record.rs"]
mod record;

const PACKAGE: &str = "@ycoding-ai/ai/providers/openai-compatible";
const FUTURE: i64 = 9_000_000_000_000;
const TEXT: &str = "data: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Answer\"},\"finish_reason\":null}]}\n\ndata: {\"id\":\"reply\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
const UNAUTHORIZED: &str = r#"{"error":{"message":"invalid token"}}"#;
const BAD_REQUEST: &str = r#"{"error":{"message":"malformed request"}}"#;
const REFRESHED: &str = r#"{"access_token":"at-new","refresh_token":"rt-new","expires_in":3600}"#;
const PROVIDER_NAME: &str = "Synthetic Upstream";

#[derive(Clone, Debug, PartialEq)]
struct Seen {
    path: String,
    authorization: Option<String>,
    body: String,
}

type Handler = Arc<dyn Fn(&Seen) -> (u16, &'static str) + Send + Sync>;

struct Stub {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Stub {
    async fn start(handler: Handler) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let handler = handler.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let boundary = loop {
                        let read = stream.read(&mut buffer).await.unwrap();
                        if read == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..read]);
                        if let Some(at) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                            break at + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&request[..boundary]).to_string();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    while request.len() - boundary < length {
                        let read = stream.read(&mut buffer).await.unwrap();
                        if read == 0 {
                            break;
                        }
                        request.extend_from_slice(&buffer[..read]);
                    }
                    let seen = Seen {
                        path: head
                            .lines()
                            .next()
                            .unwrap()
                            .split_whitespace()
                            .nth(1)
                            .unwrap()
                            .to_owned(),
                        authorization: head.lines().find_map(|line| {
                            line.to_ascii_lowercase()
                                .starts_with("authorization:")
                                .then(|| line.split_once(':').unwrap().1.trim().to_owned())
                        }),
                        body: String::from_utf8_lossy(&request[boundary..]).to_string(),
                    };
                    let (status, body) = handler(&seen);
                    log.lock().unwrap().push(seen);
                    let kind = if status == 200 && body.starts_with("data:") {
                        "text/event-stream"
                    } else {
                        "application/json"
                    };
                    let response = format!(
                        "HTTP/1.1 {status} Response\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        Self { url, seen, task }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn authorizations(&self) -> Vec<String> {
        self.seen()
            .into_iter()
            .map(|seen| seen.authorization.unwrap_or_default())
            .collect()
    }
}

struct Steady(AtomicI64);
impl Clock for Steady {
    fn now(&self) -> i64 {
        self.0.fetch_add(1, Ordering::Relaxed)
    }
    fn sleep(&self, _: u64) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async {})
    }
}

#[derive(Clone, Copy)]
enum Stored {
    OAuth,
    Key,
}

struct Fixture {
    store: Store,
    service: Service,
    coordinator: Coordinator,
    llm: Stub,
    console: Stub,
}

fn oauth_secret(console: &str) -> Secret {
    Secret::new(
        parse_json(&format!(
            r#"{{"type":"oauth","methodID":"device","access":"at-old","refresh":"rt-old","expires":{FUTURE},"metadata":{{"server":"{console}"}}}}"#
        ))
        .map(|value| credential_value(&value))
        .unwrap()
        .encode(),
    )
    .unwrap()
}

fn credential_value(value: &JsonValue) -> ycoding_schema::credential::Value {
    ycoding_schema::credential::Value::decode(value).unwrap()
}

fn key_secret() -> Secret {
    Secret::new(
        ycoding_schema::credential::Value::Key(ycoding_schema::credential::Key {
            key: "at-old".into(),
            metadata: None,
        })
        .encode(),
    )
    .unwrap()
}

async fn fixture(stored: Stored, llm: Handler, console: Handler) -> Fixture {
    let store = store();
    let llm = Stub::start(llm).await;
    let console = Stub::start(console).await;
    let credentials = credential::Service::new(store.client());
    credentials
        .create(
            "cred_work".into(),
            "opencode".into(),
            Some("work".into()),
            match stored {
                Stored::OAuth => oauth_secret(&console.url),
                Stored::Key => key_secret(),
            },
            1,
        )
        .await
        .unwrap();
    let services = Services {
        generation: ycoding_core::generation_activity::Service::new(1_000, 1_000),
        store: Service::new(store.client()),
        events: ycoding_core::event_feed::Feed::attach(&store.client()),
        location: ycoding_schema::location::Ref::decode(
            &parse_json(r#"{"directory":"/project"}"#).unwrap(),
        )
        .unwrap(),
        models: Arc::new(model::Resolver::new(catalog(&llm.url))),
        agents: ycoding_core::resources::domain_state::DomainState::new(agent::Service::new(vec![
            agent::empty("build".into()),
        ])),
        credentials,
        tools: Arc::new(Registry::new(
            Arc::new(ycoding_core::resources::tool_output_store::Store::new(
                &Roots::development(&std::env::temp_dir().join("ycoding-auth-refresh-output"))
                    .unwrap(),
            )),
            None,
            Default::default(),
            Arc::new(|left, right| left.cmp(right)),
        )),
        attachments: Arc::new(
            attachment_store::Store::new(
                std::env::temp_dir().join("ycoding-auth-refresh-attachments"),
            )
            .unwrap(),
        ),
        instructions: Vec::new(),
        analysis: None,
        clock: Arc::new(Steady(AtomicI64::new(1_000))),
        executor: Arc::new(ycoding_ai::route::Executor::new(
            ycoding_ai::route::Executor::http_client().unwrap(),
        )),
        compaction: Default::default(),
        guardrails: guardrails::guardrails(&store),
        helpers: Default::default(),
        cursor: None,
        claude: None,
        auth: Some(Default::default()),
        skill_resolver: None,
        snapshots: None,
        configuration: Some(configuration()),
        image_analyzer: None,
        extensions: Vec::new(),
        session_tools: None,
    };
    Fixture {
        service: Service::new(store.client()),
        coordinator: Coordinator::new(Arc::new(Local::new(services))),
        store,
        llm,
        console,
    }
}

async fn finish(fixture: Fixture) {
    fixture.llm.task.abort();
    fixture.console.task.abort();
    fixture.coordinator.shutdown().await.unwrap();
}

fn store() -> Store {
    let declarations = project::TABLES
        .iter()
        .chain(tables::TABLES)
        .chain(resources::TABLES)
        .chain(model_incident::TABLES)
        .copied()
        .chain([
            TableDeclaration::of::<analytics::DeliveryTable>(),
            TableDeclaration::of::<analytics::IntentTable>(),
        ])
        .collect::<Vec<_>>();
    let store = Store::disposable(
        ycoding_store::Options::core(),
        ycoding_store::Catalog::new(1, Box::leak(declarations.into_boxed_slice())),
        ycoding_store::Metadata::new([12; 16], 1),
    )
    .unwrap();
    store
        .submit(|tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
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
                    sandboxes: vec![],
                    commands: None,
                },
            )?;
            tables::SessionTable::insert(tx, &record::record("ses_one"))
        })
        .unwrap()
        .wait()
        .unwrap();
    store
}

fn catalog(endpoint: &str) -> Catalog {
    let mut catalog = Catalog::new(
        models_dev::normalize(
            &parse_json(&format!(
                r#"{{"opencode":{{"id":"opencode","name":"{PROVIDER_NAME}","env":[],"npm":"{PACKAGE}","api":"https://example.test/v1","models":{{"fake-model":{{"id":"fake-model","name":"fake-model","release_date":"2026-01-01","attachment":false,"reasoning":false,"temperature":true,"tool_call":true,"modalities":{{"input":["text"],"output":["text"]}},"cost":{{"input":1,"output":2}},"limit":{{"context":128000,"output":8192}}}}}}}}}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    catalog
        .configure(&[parse_json(&format!(
            r#"{{"model":{{"providerID":"opencode","model":"fake-model"}},"providers":{{"opencode":{{"package":"{PACKAGE}","settings":{{"baseURL":"{endpoint}"}}}}}}}}"#
        ))
        .unwrap()])
        .unwrap();
    catalog
}

fn configuration() -> Arc<Configuration> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "ycoding-runner-auth-refresh-config-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(root.join("config/ycoding")).unwrap();
    Arc::new(
        Configuration::load(LoadOptions {
            directory: root.clone(),
            roots: Roots::development(&root).unwrap(),
            project: false,
            file: None,
            content: Some("{}".into()),
            env: Default::default(),
        })
        .unwrap(),
    )
}

async fn admit(service: &Service) {
    service
        .admit(ycoding_core::session::pending::Request {
            id: session_message::Id::new("msg_input").unwrap(),
            session_id: id(),
            input: session_pending::Message::decode(
                &parse_json(
                    r#"{"type":"user","data":{"text":"Refresh on rejection"},"delivery":"steer"}"#,
                )
                .unwrap(),
            )
            .unwrap(),
            event_id: ycoding_schema::event::Id::new("evt_input").unwrap(),
            created: 1,
        })
        .await
        .unwrap();
}

fn id() -> session::Id {
    session::Id::new("ses_one").unwrap()
}

fn events(store: &Store) -> Vec<(String, JsonValue)> {
    let prefix = ycoding_store::tuple_key(&[ycoding_store::KeyPart::String(&"ses_one".into())]);
    store
        .snapshot()
        .unwrap()
        .index_range::<tables::EventTable>(
            "event_aggregate_seq_idx",
            ycoding_store::IndexQuery {
                lower: Bound::Unbounded,
                upper: Bound::Unbounded,
                prefix: Some(&prefix),
                order: ycoding_store::IndexOrder::Ascending,
                after: None,
                limit: 1000,
            },
        )
        .unwrap()
        .into_iter()
        .map(|event| {
            let kind = event.record.type_.to_utf8().unwrap();
            let name = kind
                .rsplit_once('.')
                .map_or(kind.as_str(), |(name, _)| name);
            (name.to_string(), event.record.data)
        })
        .collect()
}

fn count(events: &[(String, JsonValue)], kind: &str) -> usize {
    events.iter().filter(|(name, _)| name == kind).count()
}

fn terminals(events: &[(String, JsonValue)]) -> Vec<&str> {
    events
        .iter()
        .map(|(name, _)| name.as_str())
        .filter(|name| matches!(*name, "session.step.ended" | "session.step.failed"))
        .collect()
}

fn runner_error(result: Result<(), Error>) -> (String, String) {
    let Err(Error::Runner(error)) = result else {
        panic!("expected a Session runner failure, got {result:?}")
    };
    (
        error.r#type.as_str().unwrap().to_owned(),
        error.message.to_utf8().unwrap(),
    )
}

fn accepts_only(token: &'static str) -> Handler {
    Arc::new(move |seen| {
        if seen.authorization.as_deref() == Some(&format!("Bearer {token}")) {
            (200, TEXT)
        } else {
            (401, UNAUTHORIZED)
        }
    })
}

fn console_ok() -> Handler {
    Arc::new(|_| (200, REFRESHED))
}

fn stored_access(service: &credential::Service) -> String {
    let ycoding_schema::credential::Value::OAuth(value) = service
        .get(&"cred_work".into())
        .unwrap()
        .unwrap()
        .secret()
        .domain()
        .unwrap()
    else {
        panic!("expected an OAuth credential")
    };
    value.access.to_utf8().unwrap()
}

#[tokio::test]
async fn a_401_on_a_stored_sign_in_refreshes_once_and_retries_the_step_with_the_new_token() {
    let fixture = fixture(Stored::OAuth, accepts_only("at-new"), console_ok()).await;
    admit(&fixture.service).await;

    fixture.coordinator.run(&id()).await.unwrap();

    assert_eq!(
        fixture.llm.authorizations(),
        ["Bearer at-old", "Bearer at-new"]
    );
    let refreshes = fixture.console.seen();
    assert_eq!(refreshes.len(), 1);
    assert_eq!(refreshes[0].path, "/auth/device/token");
    assert!(
        refreshes[0].body.contains("rt-old"),
        "{}",
        refreshes[0].body
    );
    let events = events(&fixture.store);
    assert_eq!(terminals(&events), ["session.step.ended"]);
    assert_eq!(count(&events, "session.step.started"), 1);
    assert_eq!(count(&events, "session.retry.scheduled"), 0);
    let credentials = credential::Service::new(fixture.store.client());
    assert_eq!(stored_access(&credentials), "at-new");
    finish(fixture).await;
}

#[tokio::test]
async fn a_second_401_after_the_refresh_fails_with_a_reconnect_error_and_does_not_retry_again() {
    let fixture = fixture(
        Stored::OAuth,
        Arc::new(|_| (401, UNAUTHORIZED)),
        console_ok(),
    )
    .await;
    admit(&fixture.service).await;

    let (kind, message) = runner_error(fixture.coordinator.run(&id()).await);

    assert_eq!(kind, "provider.auth");
    assert_eq!(
        message,
        format!(
            "{PROVIDER_NAME} sign-in expired or was revoked and could not be refreshed: the provider rejected the refreshed sign-in. Reconnect {PROVIDER_NAME}: run /connect, choose {PROVIDER_NAME}, then Reconnect."
        )
    );
    assert_eq!(
        fixture.llm.authorizations(),
        ["Bearer at-old", "Bearer at-new"]
    );
    assert_eq!(fixture.console.seen().len(), 1);
    let events = events(&fixture.store);
    assert_eq!(terminals(&events), ["session.step.failed"]);
    finish(fixture).await;
}

#[tokio::test]
async fn a_failed_refresh_fails_the_step_with_the_exact_reason_and_sends_no_second_request() {
    let fixture = fixture(
        Stored::OAuth,
        accepts_only("at-new"),
        Arc::new(|_| (400, r#"{"error":"invalid_grant"}"#)),
    )
    .await;
    admit(&fixture.service).await;

    let (kind, message) = runner_error(fixture.coordinator.run(&id()).await);

    assert_eq!(kind, "provider.auth");
    assert_eq!(
        message,
        format!(
            "{PROVIDER_NAME} sign-in expired or was revoked and could not be refreshed: Authorization failed. Reconnect {PROVIDER_NAME}: run /connect, choose {PROVIDER_NAME}, then Reconnect."
        )
    );
    assert_eq!(fixture.llm.authorizations(), ["Bearer at-old"]);
    assert_eq!(fixture.console.seen().len(), 1);
    let credentials = credential::Service::new(fixture.store.client());
    assert_eq!(stored_access(&credentials), "at-old");
    finish(fixture).await;
}

#[tokio::test]
async fn a_non_401_provider_error_does_not_refresh_the_sign_in() {
    let fixture = fixture(
        Stored::OAuth,
        Arc::new(|_| (400, BAD_REQUEST)),
        console_ok(),
    )
    .await;
    admit(&fixture.service).await;

    let (kind, _) = runner_error(fixture.coordinator.run(&id()).await);

    assert_eq!(kind, "provider.invalid-request");
    assert_eq!(fixture.llm.authorizations(), ["Bearer at-old"]);
    assert!(fixture.console.seen().is_empty());
    finish(fixture).await;
}

#[tokio::test]
async fn a_401_on_an_api_key_profile_is_not_refreshed() {
    let fixture = fixture(Stored::Key, accepts_only("at-new"), console_ok()).await;
    admit(&fixture.service).await;

    let (kind, message) = runner_error(fixture.coordinator.run(&id()).await);

    assert_eq!(kind, "provider.auth");
    assert!(!message.contains("Reconnect"), "{message}");
    assert_eq!(fixture.llm.authorizations(), ["Bearer at-old"]);
    assert!(fixture.console.seen().is_empty());
    finish(fixture).await;
}
