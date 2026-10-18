mod remote_derived_support;
mod support;
mod connector_support {
    pub const WAIT: std::time::Duration = super::support::WAIT;
}

use remote_derived_support::{Fixture, now};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use ycoding_core::{
    mcp_events::{
        self, Authorization, Cancellation, Grant, HttpRequest, HttpResponse, Permit, ResultFuture,
        Secrets, Service, Transport, secret_box::SecretBox,
    },
    ycoding_schema::{
        DomainDecode, JsonValue,
        mcp_events::{Failure, Principal, RequestContext},
        parse_json, stringify_json,
    },
    ycoding_store::{
        self, Metadata, Options, Store,
        import::{self, DatabaseKind},
    },
};
use ycoding_runtime::{
    connector::{
        Credential, Enrolled, Peer,
        mcp::{self, Context, Request},
    },
    standard,
};

#[derive(Default)]
struct Authority {
    available: AtomicBool,
    denied: AtomicBool,
    contexts: Mutex<Vec<RequestContext>>,
    lifetime: Cancellation,
}

fn error(category: &str, reason: &str) -> Failure {
    Failure::decode(
        &parse_json(&format!(
            r#"{{"_tag":"McpEvents.Failure","category":"{category}","reason":"{reason}"}}"#
        ))
        .unwrap(),
    )
    .unwrap()
}

impl Authorization for Authority {
    fn capabilities(&self, _: Cancellation) -> ResultFuture<'_, bool> {
        Box::pin(async { Ok(self.available.load(Ordering::Acquire)) })
    }
    fn resolve(&self, context: RequestContext, _: Cancellation) -> ResultFuture<'_, Grant> {
        Box::pin(async move {
            self.contexts.lock().unwrap().push(context);
            if self.denied.load(Ordering::Acquire) {
                return Err(error("unauthorized", "grant_revoked"));
            }
            Ok(Grant {
                grant_id: "grant_synthetic".into(),
                expires_at: now() + 86_400_000,
            })
        })
    }
    fn check(&self, _: Principal, _: Cancellation) -> ResultFuture<'_, Permit> {
        Box::pin(async {
            Ok(Permit {
                expires_at: now() + 86_400_000,
                cancellation: self.lifetime.clone(),
            })
        })
    }
}

#[derive(Default)]
struct Callback {
    rejected: AtomicBool,
    requests: Mutex<Vec<HttpRequest>>,
}
impl Transport for Callback {
    fn send(&self, request: HttpRequest, _: Cancellation) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            let value = parse_json(&request.body).unwrap();
            self.requests.lock().unwrap().push(request);
            if self.rejected.load(Ordering::Acquire) {
                return Ok(HttpResponse {
                    status: 403,
                    body: String::new(),
                });
            }
            Ok(HttpResponse {
                status: 200,
                body: format!(
                    r#"{{"challenge":{}}}"#,
                    stringify_json(at(&value, &["challenge"]).unwrap())
                ),
            })
        })
    }
}

fn at<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, key| match value {
        JsonValue::Object(object) => object.get(&(*key).into()),
        _ => None,
    })
}

fn trusted() -> RequestContext {
    RequestContext::decode(&parse_json(r#"{"requestID":"forwarded_outer_id","principal":{"ownerID":"owner_synthetic","deviceID":"device-a","clientID":"client_synthetic"},"epoch":"epoch_synthetic"}"#).unwrap()).unwrap()
}

fn context(fixture: &Fixture, server: Arc<mcp::Server>, lease: mcp::Lease) -> Context {
    Context {
        environment: fixture.environment(false),
        dispatcher: Arc::new(standard().unwrap()),
        peer: peer(),
        connection_id: "events_connection".into(),
        home: fixture.path.clone(),
        access: mcp::Access::new(server, lease, Arc::new(AtomicBool::new(false))),
        trusted_context: Some(trusted()),
    }
}

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "synthetic-device-access".into(),
            now() + 3_600_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        now(),
    )
    .unwrap()
}

fn service(
    fixture: &Fixture,
    authority: Arc<Authority>,
    callback: Arc<Callback>,
) -> (Store, Arc<Service>) {
    let store = Store::disposable(
        Options::core(),
        import::catalog(DatabaseKind::Core),
        Metadata::new([94; 16], 1),
    )
    .unwrap();
    let root = fixture.root.clone();
    store
        .submit(move |tx| {
            ycoding_store::project::ProjectTable::insert(
                tx,
                &ycoding_store::project::Project {
                    id: "prj_events".into(),
                    worktree: "/synthetic-project".into(),
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
            ycoding_store::session::SessionTable::insert(
                tx,
                &ycoding_store::session::Session {
                    id: root.into(),
                    project_id: "prj_events".into(),
                    workspace_id: None,
                    parent_id: None,
                    fork_session_id: None,
                    fork_message_id: None,
                    fork_seq: None,
                    directory: "/synthetic-project".into(),
                    path: None,
                    title: "synthetic".into(),
                    cost: 0.0,
                    tokens_input: 0,
                    tokens_output: 0,
                    tokens_reasoning: 0,
                    tokens_cache_read: 0,
                    tokens_cache_write: 0,
                    revert: None,
                    permission: None,
                    autonomy: None,
                    autonomy_revision: 0,
                    orchestration_revision: 0,
                    agent: None,
                    model: None,
                    profile_binding: None,
                    daybreak: None,
                    time_created: 1,
                    time_updated: 1,
                    time_archived: None,
                    time_active: None,
                    time_pinned: None,
                    time_suspended: None,
                    usage_pruned_through: None,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    let service = Arc::new(Service::new(mcp_events::Dependencies {
        store: store.client(),
        authorization: authority,
        transport: callback,
        secrets: Secrets::Memory(Arc::new(SecretBox::new([95; 32]))),
        clock: Arc::new(now),
    }));
    (store, service)
}

async fn post(
    context: &Context,
    method: &str,
    params: &str,
) -> ycoding_runtime::connector::mcp::Response {
    let JsonValue::Object(mut params) = parse_json(params).unwrap() else {
        panic!("params object")
    };
    params.insert("_meta".into(),parse_json(r#"{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"synthetic-events","version":"1"}}"#).unwrap());
    mcp::handle(
        context,
        Request {
            body: format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"{method}","params":{}}}"#,
                stringify_json(&JsonValue::Object(params))
            )
            .into(),
            headers: vec![
                ("content-type".into(), "application/json".into()),
                ("accept".into(), "application/json".into()),
                ("mcp-protocol-version".into(), "2026-07-28".into()),
                ("mcp-method".into(), method.into()),
            ],
        },
    )
    .await
}

fn subscribe(fixture: &Fixture) -> String {
    format!(
        r#"{{"name":"session.completed","arguments":{{"session_id":"{}"}},"delivery":{{"mode":"webhook","url":"https://callback.invalid/events","secret":"whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}}}}"#,
        fixture.root
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn events_discovery_is_healthy_backend_and_trusted_context_gated_without_changing_tools() {
    let fixture = Fixture::new().await;
    let authority = Arc::new(Authority::default());
    authority.available.store(true, Ordering::Release);
    let (_store, service) = service(&fixture, authority.clone(), Arc::new(Callback::default()));
    let server = Arc::new(mcp::Server::default());
    server.install_events(service).unwrap();
    let lease =
        mcp::Lease::new(peer(), "events_connection".into(), "epoch_synthetic".into()).unwrap();
    let mut context = context(&fixture, server, lease);
    let discovery = parse_json(&post(&context, "server/discover", "{}").await.body).unwrap();
    assert!(at(&discovery, &["result", "capabilities", "events"]).is_some());
    let tools = post(&context, "tools/list", "{}").await.body;
    context.trusted_context = None;
    let discovery = parse_json(&post(&context, "server/discover", "{}").await.body).unwrap();
    assert!(at(&discovery, &["result", "capabilities", "events"]).is_none());
    assert_eq!(post(&context, "tools/list", "{}").await.body, tools);
    assert_eq!(
        at(
            &parse_json(&post(&context, "events/list", "{}").await.body).unwrap(),
            &["error", "code"]
        ),
        Some(&JsonValue::Number(-32601.0))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn subscribe_and_unsubscribe_preserve_trusted_outer_context_and_never_accept_body_authority()
{
    let fixture = Fixture::new().await;
    let authority = Arc::new(Authority::default());
    authority.available.store(true, Ordering::Release);
    let (_store, service) = service(&fixture, authority.clone(), Arc::new(Callback::default()));
    let server = Arc::new(mcp::Server::default());
    server.install_events(service).unwrap();
    let lease =
        mcp::Lease::new(peer(), "events_connection".into(), "epoch_synthetic".into()).unwrap();
    let context = context(&fixture, server, lease);
    let listed = parse_json(
        &post(&context, "events/list", r#"{"cursor":null}"#)
            .await
            .body,
    )
    .unwrap();
    let Some(JsonValue::Array(names)) = at(&listed, &["result", "events"]) else {
        panic!("event catalog")
    };
    assert_eq!(names.len(), 7);
    let result = parse_json(
        &post(&context, "events/subscribe", &subscribe(&fixture))
            .await
            .body,
    )
    .unwrap();
    assert!(at(&result, &["result", "id"]).is_some());
    assert_eq!(authority.contexts.lock().unwrap().as_slice(), [trusted()]);
    let input = format!(
        r#"{{"name":"session.completed","arguments":{{"session_id":"{}"}},"delivery":{{"mode":"webhook","url":"https://callback.invalid/events"}}}}"#,
        fixture.root
    );
    assert!(
        at(
            &parse_json(&post(&context, "events/unsubscribe", &input).await.body).unwrap(),
            &["result"]
        )
        .is_some()
    );
    let JsonValue::Object(mut forged) = parse_json(&subscribe(&fixture)).unwrap() else {
        panic!("subscription")
    };
    forged.insert(
        "context".into(),
        parse_json(r#"{"requestID":"forged","grantID":"forged"}"#).unwrap(),
    );
    let forged = stringify_json(&JsonValue::Object(forged));
    assert_eq!(
        at(
            &parse_json(&post(&context, "events/subscribe", &forged).await.body).unwrap(),
            &["error", "code"]
        ),
        Some(&JsonValue::Number(-32602.0))
    );
    assert_eq!(authority.contexts.lock().unwrap().len(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn callback_and_authority_failures_map_to_bounded_protocol_errors_without_secret_echo() {
    for denied in [false, true] {
        let fixture = Fixture::new().await;
        let authority = Arc::new(Authority::default());
        authority.available.store(true, Ordering::Release);
        authority.denied.store(denied, Ordering::Release);
        let callback = Arc::new(Callback::default());
        callback.rejected.store(!denied, Ordering::Release);
        let (_store, service) = service(&fixture, authority, callback);
        let server = Arc::new(mcp::Server::default());
        server.install_events(service).unwrap();
        let context = context(
            &fixture,
            server,
            mcp::Lease::new(peer(), "events_connection".into(), "epoch_synthetic".into()).unwrap(),
        );
        let response = post(&context, "events/subscribe", &subscribe(&fixture)).await;
        assert_eq!(
            at(&parse_json(&response.body).unwrap(), &["error", "code"]),
            Some(&JsonValue::Number(if denied { -32001.0 } else { -32015.0 }))
        );
        assert!(!response.body.contains("whsec_"));
        assert!(!response.body.contains("callback.invalid"));
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lease_loss_blocks_extension_results_and_a_new_lease_keeps_the_same_backend_rows() {
    let fixture = Fixture::new().await;
    let authority = Arc::new(Authority::default());
    authority.available.store(true, Ordering::Release);
    let (store, service) = service(&fixture, authority.clone(), Arc::new(Callback::default()));
    let server = Arc::new(mcp::Server::default());
    server.install_events(service).unwrap();
    let lease =
        mcp::Lease::new(peer(), "events_connection".into(), "epoch_synthetic".into()).unwrap();
    let mut context = context(&fixture, server.clone(), lease.clone());
    let first = parse_json(
        &post(&context, "events/subscribe", &subscribe(&fixture))
            .await
            .body,
    )
    .unwrap();
    lease.revoke();
    assert_eq!(post(&context, "events/list", "{}").await.status, 503);
    context.access = mcp::Access::new(
        server.clone(),
        mcp::Lease::new(peer(), "events_connection".into(), "epoch_synthetic".into()).unwrap(),
        Arc::new(AtomicBool::new(false)),
    );
    let second = parse_json(
        &post(&context, "events/subscribe", &subscribe(&fixture))
            .await
            .body,
    )
    .unwrap();
    assert_eq!(
        at(&first, &["result", "id"]),
        at(&second, &["result", "id"])
    );
    assert_eq!(
        store
            .snapshot()
            .unwrap()
            .scan::<ycoding_store::mcp_events::SubscriptionTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10
            )
            .unwrap()
            .len(),
        1
    );
    server.close();
    assert_eq!(post(&context, "events/list", "{}").await.status, 503);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn generic_authorization_does_not_require_an_events_service_or_a_signing_key() {
    let fixture = Fixture::new().await;
    let authority = Arc::new(Authority::default());
    authority.available.store(true, Ordering::Release);
    let server = Arc::new(mcp::Server::default());
    server.install_authorization(authority.clone()).unwrap();
    let lease =
        mcp::Lease::new(peer(), "events_connection".into(), "epoch_synthetic".into()).unwrap();
    let context = context(&fixture, server.clone(), lease.clone());
    let authorization = context.access.authorization(&trusted()).unwrap();
    assert!(
        authorization
            .capabilities(Cancellation::default())
            .await
            .unwrap()
    );
    authorization
        .resolve(trusted(), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(authority.contexts.lock().unwrap().as_slice(), [trusted()]);
    let discovery = parse_json(&post(&context, "server/discover", "{}").await.body).unwrap();
    assert!(at(&discovery, &["result", "capabilities", "events"]).is_none());
    lease.revoke();
    assert!(context.access.authorization(&trusted()).is_none());
    server.close();
    assert!(server.authorization().is_none());
}
