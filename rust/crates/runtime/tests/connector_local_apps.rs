mod remote_derived_support;
mod connector_support {
    pub const WAIT: std::time::Duration = std::time::Duration::from_secs(2);
}

use prost::{Message, Name};
use remote_derived_support::Fixture;
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
    },
};
use tokio::sync::Notify;
use ycoding_core::{
    local_app::{self, Incoming, Outgoing, Service, Sessions, Transport},
    mcp_events::{self, Authorization, Cancellation, Grant, Permit},
    ycoding_schema::{
        DomainDecode, JsonValue, LosslessString, ObjectEncoder,
        local_app::{Category, Registration, Scope},
        mcp_events::{Principal, RequestContext},
        parse_json, session, stringify_json,
    },
};
use ycoding_protocol::{OPERATIONS, domain_json, v5};
use ycoding_runtime::{
    Failure, Settled,
    connector::{
        Credential, Enrolled, Peer,
        local_apps::{
            self, Capability, Dependencies, Facade, Output, PREVIEW_URI, Preview, PreviewFuture,
        },
        mcp::{self, Context},
    },
    standard,
};

const NOW: i64 = 1_800_000_000_000;
const SESSION: &str = "ses_local_apps";
const OPERATIONS_UNDER_TEST: [(&str, &str, u32); 6] = [
    ("local_app_register", "local.app.register", 5047),
    ("local_app_list", "local.app.list", 5048),
    ("local_app_revoke", "local.app.revoke", 5049),
    ("local_app_open", "local.app.open", 5050),
    ("local_app_status", "local.app.status", 5051),
    ("local_app_http", "local.app.http", 5052),
];

fn json(value: &str) -> JsonValue {
    parse_json(value).unwrap()
}

fn at<'a>(value: &'a JsonValue, path: &[&str]) -> Option<&'a JsonValue> {
    path.iter().try_fold(value, |value, key| match value {
        JsonValue::Object(object) => object.get(&(*key).into()),
        _ => None,
    })
}

fn text(value: &JsonValue, path: &[&str]) -> String {
    match at(value, path) {
        Some(JsonValue::String(value)) => value.to_utf8().unwrap(),
        other => panic!("missing text at {path:?}: {other:?}"),
    }
}

fn trusted() -> RequestContext {
    RequestContext::decode(&json(r#"{"requestID":"outer_local_apps_request","principal":{"ownerID":"owner_synthetic","deviceID":"device-a","clientID":"client_synthetic"},"epoch":"epoch_synthetic"}"#)).unwrap()
}

fn denied() -> ycoding_core::ycoding_schema::mcp_events::Failure {
    ycoding_core::ycoding_schema::mcp_events::Failure::decode(&json(
        r#"{"_tag":"McpEvents.Failure","category":"unauthorized","reason":"grant_revoked"}"#,
    ))
    .unwrap()
}

struct Authority {
    contexts: Mutex<Vec<RequestContext>>,
    checks: AtomicUsize,
    capabilities: AtomicUsize,
    denied: AtomicBool,
    grant: Mutex<LosslessString>,
    permit: Cancellation,
}

impl Default for Authority {
    fn default() -> Self {
        Self {
            contexts: Mutex::new(Vec::new()),
            checks: AtomicUsize::new(0),
            capabilities: AtomicUsize::new(0),
            denied: AtomicBool::new(false),
            grant: Mutex::new("grant_synthetic".into()),
            permit: Cancellation::default(),
        }
    }
}

impl Authorization for Authority {
    fn capabilities(&self, _: Cancellation) -> mcp_events::ResultFuture<'_, bool> {
        self.capabilities.fetch_add(1, Ordering::AcqRel);
        Box::pin(async { Ok(true) })
    }

    fn resolve(
        &self,
        context: RequestContext,
        _: Cancellation,
    ) -> mcp_events::ResultFuture<'_, Grant> {
        Box::pin(async move {
            self.contexts.lock().unwrap().push(context);
            if self.denied.load(Ordering::Acquire) {
                return Err(denied());
            }
            Ok(Grant {
                grant_id: self.grant.lock().unwrap().clone(),
                expires_at: NOW + 3_600_000,
            })
        })
    }

    fn check(&self, _: Principal, _: Cancellation) -> mcp_events::ResultFuture<'_, Permit> {
        Box::pin(async move {
            self.checks.fetch_add(1, Ordering::AcqRel);
            if self.denied.load(Ordering::Acquire) {
                return Err(denied());
            }
            Ok(Permit {
                expires_at: NOW + 3_600_000,
                cancellation: self.permit.clone(),
            })
        })
    }
}

struct BackendSessions {
    allowed: AtomicBool,
    observed: Mutex<Vec<session::Id>>,
}

impl Sessions for BackendSessions {
    fn verify(&self, session: session::Id, _: Cancellation) -> local_app::ResultFuture<'_, bool> {
        Box::pin(async move {
            self.observed.lock().unwrap().push(session);
            Ok(self.allowed.load(Ordering::Acquire))
        })
    }
}

struct Upstream {
    requests: Mutex<Vec<Outgoing>>,
    body: Mutex<Vec<u8>>,
    headers: Mutex<BTreeMap<String, String>>,
    status: AtomicUsize,
    hold: AtomicBool,
    entered: Notify,
    release: Cancellation,
    authority: Arc<Authority>,
    revoke_after_send: AtomicBool,
    failed: AtomicBool,
}

struct Body(Option<Vec<u8>>);

impl local_app::Body for Body {
    fn next(&mut self) -> local_app::ResultFuture<'_, Option<Vec<u8>>> {
        let bytes = self.0.take();
        Box::pin(async move { Ok(bytes) })
    }
}

impl Transport for Upstream {
    fn send(
        &self,
        request: Outgoing,
        cancellation: Cancellation,
    ) -> local_app::ResultFuture<'_, Incoming> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            self.entered.notify_one();
            if self.hold.load(Ordering::Acquire) {
                tokio::select! {
                    _ = self.release.cancelled() => {},
                    _ = cancellation.cancelled() => return Err(ycoding_core::ycoding_schema::local_app::Failure { category: Category::UpstreamUnavailable }),
                }
            }
            if self.revoke_after_send.load(Ordering::Acquire) {
                self.authority.denied.store(true, Ordering::Release);
            }
            if self.failed.load(Ordering::Acquire) {
                return Err(ycoding_core::ycoding_schema::local_app::Failure {
                    category: Category::UpstreamUnavailable,
                });
            }
            Ok(Incoming {
                status: self.status.load(Ordering::Acquire) as u16,
                headers: self.headers.lock().unwrap().clone(),
                body: Box::new(Body(Some(self.body.lock().unwrap().clone()))),
            })
        })
    }
}

struct Issuer {
    calls: AtomicUsize,
    capability: Mutex<Capability>,
    hold: AtomicBool,
    entered: Notify,
    release: Cancellation,
}

impl Issuer {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            capability: Mutex::new(Capability {
                url: "https://preview.example.test/_ycoding/bootstrap?ticket=fixture_token_0123456789".into(),
                origin: "https://preview.example.test".into(),
                expires_at: NOW + 60_000,
            }),
            hold: AtomicBool::new(false),
            entered: Notify::new(),
            release: Cancellation::default(),
        }
    }
}

impl Preview for Issuer {
    fn origins(&self) -> Vec<String> {
        vec!["https://preview.example.test".into()]
    }

    fn issue(&self, _: Registration, _: Scope, cancellation: Cancellation) -> PreviewFuture<'_> {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::AcqRel);
            self.entered.notify_one();
            if self.hold.load(Ordering::Acquire) {
                tokio::select! {
                    _ = self.release.cancelled() => {},
                    _ = cancellation.cancelled() => return Err(Failure::Connector { code: 3, message: "Local app access is unavailable" }),
                }
            }
            let capability = self.capability.lock().unwrap();
            Ok(Capability {
                url: capability.url.clone(),
                origin: capability.origin.clone(),
                expires_at: capability.expires_at,
            })
        })
    }
}

struct World {
    facade: Arc<Facade>,
    sessions: Arc<BackendSessions>,
    authority: Arc<Authority>,
    upstream: Arc<Upstream>,
    clock: Arc<AtomicI64>,
}

impl World {
    fn new(preview: Option<Arc<dyn Preview>>) -> Self {
        let authority = Arc::new(Authority::default());
        let sessions = Arc::new(BackendSessions {
            allowed: AtomicBool::new(true),
            observed: Mutex::new(Vec::new()),
        });
        let upstream = Arc::new(Upstream {
            requests: Mutex::new(Vec::new()),
            body: Mutex::new(vec![0, 255, 137, 10]),
            headers: Mutex::new(BTreeMap::new()),
            status: AtomicUsize::new(200),
            hold: AtomicBool::new(false),
            entered: Notify::new(),
            release: Cancellation::default(),
            authority: authority.clone(),
            revoke_after_send: AtomicBool::new(false),
            failed: AtomicBool::new(false),
        });
        let clock = Arc::new(AtomicI64::new(NOW));
        let current = clock.clone();
        let registry = Arc::new(Service::new(local_app::Dependencies {
            sessions: sessions.clone(),
            authorization: authority.clone(),
            transport: upstream.clone(),
            clock: Arc::new(move || current.load(Ordering::Acquire)),
        }));
        let current = clock.clone();
        let facade = Arc::new(Facade::new(Dependencies {
            registry: registry.clone(),
            authorization: authority.clone(),
            preview,
            clock: Arc::new(move || current.load(Ordering::Acquire)),
        }));
        Self {
            facade,
            sessions,
            authority,
            upstream,
            clock,
        }
    }

    async fn execute(&self, operation: &str, raw: JsonValue) -> Result<Output, Failure> {
        self.facade
            .execute(operation, raw, Some(trusted()), Cancellation::default())
            .await
    }

    async fn register(&self) -> Output {
        self.execute("local.app.register", registration(SESSION))
            .await
            .unwrap()
    }
}

fn registration(session: &str) -> JsonValue {
    json(&format!(
        r#"{{"sessionID":"{session}","input":{{"host":"127.0.0.1","port":43210,"entryPath":"/app/index.html","routes":[{{"path":"/app","match":"prefix","methods":["GET","HEAD","POST"]}}]}}}}"#
    ))
}

fn arguments(app: &Output, operation: &str) -> JsonValue {
    let id = text(&app.value, &["id"]);
    let generation = text(&app.value, &["generation"]);
    json(&match operation {
        "local.app.list" => format!(r#"{{"sessionID":"{SESSION}"}}"#),
        "local.app.open" => format!(
            r#"{{"sessionID":"{SESSION}","input":{{"id":"{id}","generation":"{generation}"}}}}"#
        ),
        "local.app.http" => format!(
            r#"{{"sessionID":"{SESSION}","input":{{"id":"{id}","generation":"{generation}","method":"GET","path":"/app/index.html"}}}}"#
        ),
        _ => format!(r#"{{"sessionID":"{SESSION}","input":{{"id":"{id}"}}}}"#),
    })
}

fn input_field(mut raw: JsonValue, key: &str, value: JsonValue) -> JsonValue {
    let JsonValue::Object(ref mut object) = raw else {
        panic!("arguments object")
    };
    let JsonValue::Object(mut input) = object.get(&"input".into()).unwrap().clone() else {
        panic!("input object")
    };
    input.insert(key.into(), value);
    object.insert("input".into(), JsonValue::Object(input));
    raw
}

#[test]
fn six_local_app_tools_use_closed_secret_session_operations_without_a_location_selector() {
    for (tool, operation, id) in OPERATIONS_UNDER_TEST {
        let descriptor = OPERATIONS
            .iter()
            .find(|entry| entry.diagnostic_name == operation)
            .expect(operation);
        assert_eq!(descriptor.operation_id, id);
        assert_eq!(descriptor.scope, v5::ScopeKind::Session as i32);
        assert_eq!(descriptor.sensitivity, v5::Sensitivity::Secret as i32);
        assert_eq!(descriptor.streaming, v5::Streaming::TypedBulk as i32);
        assert_eq!(descriptor.settlement, v5::Settlement::Completed as i32);
        assert_eq!(
            descriptor.mutation == v5::MutationClass::Read as i32,
            matches!(operation, "local.app.list" | "local.app.status")
        );
        assert!(
            descriptor
                .roles
                .contains(&(v5::PeerRole::RemoteClient as i32))
        );
        assert!(descriptor.roles.contains(&(v5::PeerRole::Relay as i32)));
        assert!(
            descriptor
                .error_types
                .iter()
                .any(|name| name == "ycoding.v5.Connector_Error")
        );
        assert!(
            mcp::tools()
                .iter()
                .any(|entry| entry.name == tool && entry.operation == Some(operation))
        );
        let request = domain_json::message(&descriptor.request_type).unwrap();
        assert!(
            !request
                .fields
                .iter()
                .any(|field| field.name.to_ascii_lowercase().contains("location"))
        );
    }
    let mut dispatcher = ycoding_runtime::Dispatcher::new(OPERATIONS.clone());
    local_apps::register(&mut dispatcher).unwrap();
}

#[tokio::test]
async fn ordinary_remote_and_local_calls_cannot_obtain_mcp_app_authority() {
    let fixture = Fixture::new().await;
    let dispatcher = standard().unwrap();
    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "synthetic-device-access".into(),
            NOW + 3_600_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        NOW,
    )
    .unwrap();
    for (_, operation, _) in OPERATIONS_UNDER_TEST {
        let descriptor = OPERATIONS
            .iter()
            .find(|entry| entry.diagnostic_name == operation)
            .unwrap();
        let input = if operation == "local.app.list" {
            JsonValue::Object(Default::default())
        } else if operation == "local.app.register" {
            at(&registration(&fixture.root), &["input"])
                .unwrap()
                .clone()
        } else {
            let id = format!("app_{}", "a".repeat(32));
            let generation = format!("generation_{}", "b".repeat(32));
            json(&match operation {
                "local.app.open" => format!(r#"{{"id":"{id}","generation":"{generation}"}}"#),
                "local.app.http" => format!(
                    r#"{{"id":"{id}","generation":"{generation}","method":"GET","path":"/app/index.html"}}"#
                ),
                _ => format!(r#"{{"id":"{id}"}}"#),
            })
        };
        let mut payload = ObjectEncoder::new();
        if operation != "local.app.list" {
            payload = payload.field("payload", &input);
        }
        let request = v5::Request {
            request_id: "untrusted-local-app".into(),
            operation_id: descriptor.operation_id,
            scope: v5::Scope {
                target: Some(v5::scope::Target::Session(fixture.root.clone())),
            },
            payload: domain_json::encode(
                &descriptor.request_type,
                &domain(&payload.finish()),
                128 * 1024,
            )
            .unwrap(),
        };
        assert!(
            dispatcher
                .invoke(
                    fixture.environment(true),
                    "ordinary-local".into(),
                    request.clone()
                )
                .await
                .is_none()
        );
        let settled = dispatcher
            .invoke_remote(
                fixture.environment(true),
                "ordinary-remote".into(),
                &peer,
                request,
            )
            .await
            .unwrap();
        assert!(
            matches!(settled, Settled::Result(v5::Result { outcome: Some(v5::result::Outcome::Error(payload)), .. }) if payload.type_name == "ycoding.v5.Connector_Error")
        );
    }
}

fn domain(value: &JsonValue) -> domain_json::Domain {
    match value {
        JsonValue::Null => domain_json::Domain::Null,
        JsonValue::Bool(value) => domain_json::Domain::Bool(*value),
        JsonValue::Number(value) => domain_json::Domain::Number(*value),
        JsonValue::String(value) => domain_json::Domain::Text(value.code_units().collect()),
        JsonValue::Array(value) => domain_json::Domain::List(value.iter().map(domain).collect()),
        JsonValue::Object(value) => domain_json::Domain::Object(
            value
                .iter()
                .map(|(key, value)| (key.code_units().collect(), domain(value)))
                .collect(),
        ),
    }
}

#[tokio::test]
async fn registration_uses_backend_session_authority_and_returns_only_safe_detached_metadata() {
    let world = World::new(None);
    let app = world.register().await;
    assert!(app.metadata.is_none());
    let value = stringify_json(&app.value);
    for forbidden in [
        "43210",
        "127.0.0.1",
        "ownerID",
        "deviceID",
        "grantID",
        "clientID",
        "epoch",
    ] {
        assert!(!value.contains(forbidden));
    }
    assert!(!world.sessions.observed.lock().unwrap().is_empty());
    assert!(
        world
            .sessions
            .observed
            .lock()
            .unwrap()
            .iter()
            .all(|session| session.as_lossless().as_str() == Some(SESSION))
    );
    assert!(
        world
            .authority
            .contexts
            .lock()
            .unwrap()
            .iter()
            .all(|context| context == &trusted())
    );
    assert_eq!(world.authority.capabilities.load(Ordering::Acquire), 0);
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    let listed = world
        .execute("local.app.list", arguments(&app, "local.app.list"))
        .await
        .unwrap();
    assert_eq!(listed.value, JsonValue::Array(vec![app.value.clone()]));
    world.sessions.allowed.store(false, Ordering::Release);
    assert!(
        world
            .execute("local.app.register", registration("ses_missing"))
            .await
            .is_err()
    );
    world.facade.close().await;
}

#[tokio::test]
async fn absent_context_extra_authority_fields_and_caller_locations_are_rejected_without_contact() {
    let world = World::new(None);
    let app = world.register().await;
    for (_, operation, _) in OPERATIONS_UNDER_TEST {
        let raw = if operation == "local.app.register" {
            registration(SESSION)
        } else {
            arguments(&app, operation)
        };
        assert!(
            world
                .facade
                .execute(operation, raw, None, Cancellation::default())
                .await
                .is_err()
        );
    }
    for raw in [
        r#"{"sessionID":"ses_local_apps","input":{"host":"localhost","port":43210,"entryPath":"/","routes":[]}}"#,
        r#"{"sessionID":"ses_local_apps","ownerID":"injected","input":{}}"#,
        r#"{"sessionID":"ses_local_apps","location":{"directory":"/synthetic"},"input":{}}"#,
        r#"{"sessionID":"ses_local_apps","input":{"host":"127.0.0.1","port":43210,"entryPath":"/","routes":[],"grantID":"injected"}}"#,
    ] {
        assert!(
            world
                .execute("local.app.register", json(raw))
                .await
                .is_err()
        );
    }
    for field in [
        "ownerID", "deviceID", "clientID", "grantID", "epoch", "scope", "location",
    ] {
        let JsonValue::Object(mut raw) = registration(SESSION) else {
            unreachable!()
        };
        raw.insert(field.into(), JsonValue::String("injected".into()));
        assert!(
            world
                .execute("local.app.register", JsonValue::Object(raw))
                .await
                .is_err()
        );
        let raw = input_field(
            registration(SESSION),
            field,
            JsonValue::String("injected".into()),
        );
        assert!(world.execute("local.app.register", raw).await.is_err());
    }
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    world.facade.close().await;
}

#[tokio::test]
async fn unconfigured_preview_never_publishes_or_contacts_the_app_but_explicit_http_remains_usable()
{
    let world = World::new(None);
    let app = world.register().await;
    for operation in ["local.app.open", "local.app.status"] {
        let output = world
            .execute(operation, arguments(&app, operation))
            .await
            .unwrap();
        assert_eq!(text(&output.value, &["status"]), "unavailable");
        assert_eq!(text(&output.value, &["reason"]), "preview_unconfigured");
        assert!(output.metadata.is_none());
    }
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    let output = world
        .execute("local.app.http", arguments(&app, "local.app.http"))
        .await
        .unwrap();
    assert_eq!(
        at(&output.value, &["status"]),
        Some(&JsonValue::Number(200.0))
    );
    assert_eq!(text(&output.value, &["body"]), "AP+JCg==");
    assert_eq!(world.upstream.requests.lock().unwrap().len(), 1);
    world.facade.close().await;
}

#[tokio::test]
async fn preview_bootstrap_is_private_metadata_and_only_open_links_the_fixed_resource() {
    let issuer = Arc::new(Issuer::new());
    let world = World::new(Some(issuer.clone()));
    let app = world.register().await;
    let opened = world
        .execute("local.app.open", arguments(&app, "local.app.open"))
        .await
        .unwrap();
    assert_eq!(text(&opened.value, &["status"]), "ready");
    let metadata = opened.metadata.as_ref().unwrap();
    assert_eq!(
        text(metadata, &["localApp", "origin"]),
        "https://preview.example.test"
    );
    assert!(text(metadata, &["localApp", "url"]).contains("/_ycoding/bootstrap?ticket="));
    let public = stringify_json(&opened.value);
    for forbidden in [
        "ticket",
        "bootstrap",
        "https://preview",
        "43210",
        "127.0.0.1",
    ] {
        assert!(!public.contains(forbidden));
    }
    assert_eq!(issuer.calls.load(Ordering::Acquire), 1);
    let status = world
        .execute("local.app.status", arguments(&app, "local.app.status"))
        .await
        .unwrap();
    assert_eq!(status.value, opened.value);
    assert!(status.metadata.is_none());
    assert_eq!(issuer.calls.load(Ordering::Acquire), 1);
    let resource = world.facade.resource(PREVIEW_URI).unwrap();
    let resource = stringify_json(&resource);
    assert!(resource.contains("text/html;profile=mcp-app"));
    assert!(resource.contains("frameDomains"));
    assert!(resource.contains("https://preview.example.test"));
    assert!(!resource.contains("fixture_token"));
    assert!(
        world
            .facade
            .resource("https://untrusted.invalid/index.html")
            .is_none()
    );
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    world.facade.close().await;
}

#[tokio::test]
async fn invalid_preview_capabilities_never_leak_or_contact_upstream() {
    for url in [
        "https://other.invalid/_ycoding/bootstrap?ticket=fixture",
        "https://preview.example.test/app?ticket=fixture",
        "https://preview.example.test/_ycoding/bootstrap?ticket=fixture&extra=1",
    ] {
        let issuer = Arc::new(Issuer::new());
        issuer.capability.lock().unwrap().url = url.into();
        let world = World::new(Some(issuer));
        let app = world.register().await;
        assert!(
            world
                .execute("local.app.open", arguments(&app, "local.app.open"))
                .await
                .is_err()
        );
        assert!(world.upstream.requests.lock().unwrap().is_empty());
        world.facade.close().await;
    }
}

#[tokio::test]
async fn every_identity_axis_and_generation_fences_existing_registration_access() {
    let world = World::new(None);
    let app = world.register().await;
    for axis in ["ownerID", "deviceID", "clientID", "epoch"] {
        let mut context = trusted();
        match axis {
            "ownerID" => context.principal.owner_id = "other_identity".into(),
            "deviceID" => context.principal.device_id = "other_identity".into(),
            "clientID" => context.principal.client_id = "other_identity".into(),
            _ => context.epoch = "other_epoch".into(),
        }
        let output = world
            .facade
            .execute(
                "local.app.list",
                arguments(&app, "local.app.list"),
                Some(context.clone()),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(output.value, JsonValue::Array(Vec::new()));
        let output = world
            .facade
            .execute(
                "local.app.status",
                arguments(&app, "local.app.status"),
                Some(context),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_ne!(text(&output.value, &["status"]), "ready");
    }
    let JsonValue::Object(mut other_session) = arguments(&app, "local.app.list") else {
        unreachable!()
    };
    other_session.insert("sessionID".into(), JsonValue::String("ses_other".into()));
    assert_eq!(
        world
            .execute("local.app.list", JsonValue::Object(other_session))
            .await
            .unwrap()
            .value,
        JsonValue::Array(Vec::new())
    );
    *world.authority.grant.lock().unwrap() = "replacement_grant".into();
    assert!(
        matches!(world.execute("local.app.list", arguments(&app, "local.app.list")).await.unwrap().value, JsonValue::Array(value) if value.is_empty())
    );
    *world.authority.grant.lock().unwrap() = "grant_synthetic".into();
    let raw = input_field(
        arguments(&app, "local.app.http"),
        "generation",
        JsonValue::String(format!("generation_{}", "0".repeat(32)).into()),
    );
    assert!(world.execute("local.app.http", raw).await.is_err());
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    world.facade.close().await;
}

#[tokio::test]
async fn facade_http_enforces_canonical_base64_and_its_smaller_body_bounds_before_contact() {
    let world = World::new(None);
    let app = world.register().await;
    for body in ["A", "AA=", "AB==", "AA==\n", "!!!!"] {
        let raw = input_field(
            arguments(&app, "local.app.http"),
            "body",
            JsonValue::String(body.into()),
        );
        assert!(world.execute("local.app.http", raw).await.is_err());
    }
    let raw = input_field(
        arguments(&app, "local.app.http"),
        "body",
        JsonValue::String(format!("{}AAA=", "AAAA".repeat(21_845)).into()),
    );
    assert!(world.execute("local.app.http", raw).await.is_err());
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    let raw = input_field(
        arguments(&app, "local.app.http"),
        "body",
        JsonValue::String(format!("{}AA==", "AAAA".repeat(21_845)).into()),
    );
    let raw = input_field(raw, "method", JsonValue::String("POST".into()));
    assert!(world.execute("local.app.http", raw).await.is_ok());
    *world.upstream.body.lock().unwrap() = vec![0; 1_048_576];
    let maximum = world
        .execute("local.app.http", arguments(&app, "local.app.http"))
        .await
        .unwrap();
    assert_eq!(text(&maximum.value, &["body"]).len(), 1_398_104);
    *world.upstream.body.lock().unwrap() = vec![0; 1_048_577];
    assert!(
        world
            .execute("local.app.http", arguments(&app, "local.app.http"))
            .await
            .is_err()
    );
    assert_eq!(world.upstream.requests.lock().unwrap().len(), 3);
    world.facade.close().await;
}

#[tokio::test]
async fn facade_http_preserves_binary_status_and_headers_without_exposing_response_credentials() {
    let world = World::new(None);
    let app = world.register().await;
    world.upstream.status.store(206, Ordering::Release);
    *world.upstream.headers.lock().unwrap() = BTreeMap::from([
        ("content-type".into(), "image/png".into()),
        ("etag".into(), "\"fixture\"".into()),
        ("content-range".into(), "bytes 0-3/4".into()),
        ("set-cookie".into(), "synthetic_private=1".into()),
    ]);
    let output = world
        .execute("local.app.http", arguments(&app, "local.app.http"))
        .await
        .unwrap();
    assert_eq!(
        at(&output.value, &["status"]),
        Some(&JsonValue::Number(206.0))
    );
    assert_eq!(text(&output.value, &["body"]), "AP+JCg==");
    assert_eq!(
        text(&output.value, &["headers", "content-type"]),
        "image/png"
    );
    assert_eq!(text(&output.value, &["headers", "etag"]), "\"fixture\"");
    assert!(!stringify_json(&output.value).contains("synthetic_private"));
    assert!(output.metadata.is_none());
    world.facade.close().await;
}

#[tokio::test]
async fn authority_revocation_after_contact_suppresses_the_response_without_replay() {
    let world = World::new(None);
    let app = world.register().await;
    world
        .upstream
        .revoke_after_send
        .store(true, Ordering::Release);
    assert!(
        world
            .execute("local.app.http", arguments(&app, "local.app.http"))
            .await
            .is_err()
    );
    assert_eq!(world.upstream.requests.lock().unwrap().len(), 1);
    world.facade.close().await;
}

#[tokio::test]
async fn upstream_failure_redirect_and_stream_rejections_remain_sanitized_without_replay() {
    for variant in ["failure", "redirect", "stream"] {
        let world = World::new(None);
        let app = world.register().await;
        if variant == "failure" {
            world.upstream.failed.store(true, Ordering::Release);
        }
        if variant == "redirect" {
            world.upstream.status.store(302, Ordering::Release);
            world.upstream.headers.lock().unwrap().insert(
                "location".into(),
                "https://private-upstream.invalid/secret".into(),
            );
        }
        if variant == "stream" {
            world
                .upstream
                .headers
                .lock()
                .unwrap()
                .insert("content-type".into(), "text/event-stream".into());
        }
        let error = world
            .execute("local.app.http", arguments(&app, "local.app.http"))
            .await
            .err()
            .unwrap();
        assert!(matches!(error, Failure::Connector { .. }));
        assert!(!format!("{error:?}").contains("private-upstream"));
        assert!(!format!("{error:?}").contains("127.0.0.1"));
        assert_eq!(world.upstream.requests.lock().unwrap().len(), 1);
        world.facade.close().await;
    }
}

#[tokio::test]
async fn grant_replacement_during_preview_issue_cannot_publish_a_stale_capability() {
    let issuer = Arc::new(Issuer::new());
    issuer.hold.store(true, Ordering::Release);
    let world = World::new(Some(issuer.clone()));
    let app = world.register().await;
    let facade = world.facade.clone();
    let raw = arguments(&app, "local.app.open");
    let opening = tokio::spawn(async move {
        facade
            .execute(
                "local.app.open",
                raw,
                Some(trusted()),
                Cancellation::default(),
            )
            .await
    });
    issuer.entered.notified().await;
    *world.authority.grant.lock().unwrap() = "replacement_grant".into();
    issuer.release.cancel();
    assert!(opening.await.unwrap().is_err());
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    world.facade.close().await;
}

#[tokio::test]
async fn revocation_expiry_and_disconnect_end_access_without_reusing_a_registry() {
    let world = World::new(None);
    let app = world.register().await;
    let revoked = world
        .execute("local.app.revoke", arguments(&app, "local.app.revoke"))
        .await
        .unwrap();
    assert_eq!(text(&revoked.value, &["status"]), "revoked");
    assert!(
        world
            .execute("local.app.http", arguments(&app, "local.app.http"))
            .await
            .is_err()
    );
    let app = world.register().await;
    world.clock.store(NOW + 900_000, Ordering::Release);
    let expired = world
        .execute("local.app.status", arguments(&app, "local.app.status"))
        .await
        .unwrap();
    assert_eq!(text(&expired.value, &["status"]), "expired");
    world.facade.close().await;
    assert!(
        world
            .execute("local.app.register", registration(SESSION))
            .await
            .is_err()
    );
    let next = World::new(None);
    let absent = next
        .execute("local.app.status", arguments(&app, "local.app.status"))
        .await
        .unwrap();
    assert_eq!(text(&absent.value, &["reason"]), "not_registered");
    assert!(next.upstream.requests.lock().unwrap().is_empty());
    next.facade.close().await;
}

#[tokio::test]
async fn close_cancels_and_joins_active_http_work_without_another_dispatch() {
    let world = World::new(None);
    let app = world.register().await;
    world.upstream.hold.store(true, Ordering::Release);
    let facade = world.facade.clone();
    let raw = arguments(&app, "local.app.http");
    let sending = tokio::spawn(async move {
        facade
            .execute(
                "local.app.http",
                raw,
                Some(trusted()),
                Cancellation::default(),
            )
            .await
    });
    world.upstream.entered.notified().await;
    let closing = world.facade.close();
    assert!(
        world
            .execute("local.app.register", registration(SESSION))
            .await
            .is_err()
    );
    assert!(world.facade.resource(PREVIEW_URI).is_none());
    assert!(sending.await.unwrap().is_err());
    closing.await;
    assert_eq!(world.upstream.requests.lock().unwrap().len(), 1);
}

fn peer() -> Peer {
    Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "synthetic-device-access".into(),
            NOW + 3_600_000,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        NOW,
    )
    .unwrap()
}

fn context(fixture: &Fixture, world: &World, dispatcher: ycoding_runtime::Dispatcher) -> Context {
    let server = Arc::new(mcp::Server::default());
    server
        .install_authorization(world.authority.clone())
        .unwrap();
    let lease = mcp::Lease::new(
        peer(),
        "local_apps_connection".into(),
        "epoch_synthetic".into(),
    )
    .unwrap();
    lease.install_local_apps(world.facade.clone()).unwrap();
    Context {
        environment: fixture.environment(true),
        dispatcher: Arc::new(dispatcher),
        peer: peer(),
        connection_id: "local_apps_connection".into(),
        home: fixture.path.clone(),
        access: mcp::Access::new(server, lease, Arc::new(AtomicBool::new(false))),
        trusted_context: Some(trusted()),
    }
}

async fn post(context: &Context, method: &str, mut params: JsonValue) -> JsonValue {
    let JsonValue::Object(ref mut object) = params else {
        panic!("params object")
    };
    object.insert("_meta".into(), json(r#"{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{},"io.modelcontextprotocol/clientInfo":{"name":"synthetic-local-apps","version":"1"}}"#));
    let mut headers = vec![
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "application/json".into()),
        ("mcp-protocol-version".into(), "2026-07-28".into()),
        ("mcp-method".into(), method.into()),
    ];
    if let Some(key) = match method {
        "tools/call" => Some("name"),
        "resources/read" => Some("uri"),
        _ => None,
    } && let Some(JsonValue::String(name)) = object.get(&key.into())
    {
        headers.push(("mcp-name".into(), name.clone()));
    }
    let response = mcp::handle(
        context,
        mcp::Request {
            body: format!(
                r#"{{"jsonrpc":"2.0","id":7,"method":"{method}","params":{}}}"#,
                stringify_json(&params)
            )
            .into(),
            headers,
        },
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.body);
    parse_json(&response.body).unwrap()
}

fn tool_call(name: &str, arguments: JsonValue) -> JsonValue {
    ObjectEncoder::new()
        .field("name", name)
        .field("arguments", &arguments)
        .finish()
}

#[tokio::test]
async fn actual_mcp_registration_uses_backend_placement_and_outer_context_with_private_open_metadata()
 {
    let fixture = Fixture::new().await;
    let issuer = Arc::new(Issuer::new());
    let world = World::new(Some(issuer));
    let mut context = context(&fixture, &world, standard().unwrap());
    let tools = post(&context, "tools/list", json("{}")).await;
    let Some(JsonValue::Array(tools)) = at(&tools, &["result", "tools"]) else {
        panic!("tools")
    };
    for (name, _, _) in OPERATIONS_UNDER_TEST {
        let tool = tools
            .iter()
            .find(|tool| text(tool, &["name"]) == name)
            .unwrap();
        assert_eq!(
            at(tool, &["_meta", "ui", "resourceUri"]).is_some(),
            name == "local_app_open"
        );
    }
    let registered = post(
        &context,
        "tools/call",
        tool_call("local_app_register", registration(&fixture.root)),
    )
    .await;
    let app = at(&registered, &["result", "structuredContent"]).unwrap();
    let id = text(app, &["id"]);
    let generation = text(app, &["generation"]);
    assert_eq!(text(app, &["sessionID"]), fixture.root);
    assert!(
        world
            .sessions
            .observed
            .lock()
            .unwrap()
            .iter()
            .all(|session| session.as_lossless().as_str() == Some(fixture.root.as_str()))
    );
    assert!(
        world
            .authority
            .contexts
            .lock()
            .unwrap()
            .iter()
            .all(|context| context == &trusted())
    );
    let opened = post(
        &context,
        "tools/call",
        tool_call(
            "local_app_open",
            json(&format!(
                r#"{{"sessionID":"{}","input":{{"id":"{id}","generation":"{generation}"}}}}"#,
                fixture.root
            )),
        ),
    )
    .await;
    assert_eq!(
        text(&opened, &["result", "structuredContent", "status"]),
        "ready"
    );
    assert!(
        text(&opened, &["result", "_meta", "localApp", "url"])
            .contains("/_ycoding/bootstrap?ticket=")
    );
    assert_eq!(
        text(
            &opened,
            &[
                "result",
                "_meta",
                "io.modelcontextprotocol/serverInfo",
                "name"
            ]
        ),
        "ycoding-remote"
    );
    for path in [["result", "content"], ["result", "structuredContent"]] {
        let public = stringify_json(at(&opened, &path).unwrap());
        assert!(!public.contains("fixture_token"));
        assert!(!public.contains("https://preview"));
    }
    context.trusted_context = None;
    let refused = post(
        &context,
        "tools/call",
        tool_call(
            "local_app_list",
            json(&format!(r#"{{"sessionID":"{}"}}"#, fixture.root)),
        ),
    )
    .await;
    assert_eq!(
        at(&refused, &["result", "isError"]),
        Some(&JsonValue::Bool(true))
    );
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    world.facade.close().await;
}

fn trap<Q, R>(dispatcher: &mut ycoding_runtime::Dispatcher, name: &str, calls: Arc<AtomicUsize>)
where
    Q: Message + Name + Default + 'static,
    R: Message + Name + Default + 'static,
{
    dispatcher
        .handle::<Q, R, _, _>(name, move |_, _| {
            let calls = calls.clone();
            async move {
                calls.fetch_add(1, Ordering::AcqRel);
                Err(Failure::Connector {
                    code: 3,
                    message: "Closed local app test boundary",
                })
            }
        })
        .unwrap();
}

#[tokio::test]
async fn all_six_mcp_tools_reach_the_closed_dispatcher_instead_of_calling_the_facade_directly() {
    let fixture = Fixture::new().await;
    let world = World::new(None);
    let mut dispatcher = ycoding_runtime::Dispatcher::new(OPERATIONS.clone());
    let calls = (0..6)
        .map(|_| Arc::new(AtomicUsize::new(0)))
        .collect::<Vec<_>>();
    trap::<v5::LocalAppRegisterRequest, v5::LocalAppRegisterResult>(
        &mut dispatcher,
        "local.app.register",
        calls[0].clone(),
    );
    trap::<v5::LocalAppListRequest, v5::LocalAppListResult>(
        &mut dispatcher,
        "local.app.list",
        calls[1].clone(),
    );
    trap::<v5::LocalAppRevokeRequest, v5::LocalAppRevokeResult>(
        &mut dispatcher,
        "local.app.revoke",
        calls[2].clone(),
    );
    trap::<v5::LocalAppOpenRequest, v5::LocalAppOpenResult>(
        &mut dispatcher,
        "local.app.open",
        calls[3].clone(),
    );
    trap::<v5::LocalAppStatusRequest, v5::LocalAppStatusResult>(
        &mut dispatcher,
        "local.app.status",
        calls[4].clone(),
    );
    trap::<v5::LocalAppHttpRequest, v5::LocalAppHttpResult>(
        &mut dispatcher,
        "local.app.http",
        calls[5].clone(),
    );
    let context = context(&fixture, &world, dispatcher);
    let app = Output {
        value: json(&format!(
            r#"{{"id":"app_{}","generation":"generation_{}"}}"#,
            "a".repeat(32),
            "b".repeat(32)
        )),
        metadata: None,
    };
    for (index, (name, operation, _)) in OPERATIONS_UNDER_TEST.into_iter().enumerate() {
        let raw = if operation == "local.app.register" {
            registration(&fixture.root)
        } else {
            let JsonValue::Object(mut raw) = arguments(&app, operation) else {
                unreachable!()
            };
            raw.insert(
                "sessionID".into(),
                JsonValue::String(fixture.root.clone().into()),
            );
            JsonValue::Object(raw)
        };
        let result = post(&context, "tools/call", tool_call(name, raw)).await;
        assert_eq!(
            at(&result, &["result", "isError"]),
            Some(&JsonValue::Bool(true))
        );
        assert_eq!(
            calls[index].load(Ordering::Acquire),
            1,
            "{name} bypassed its closed operation"
        );
    }
    assert!(world.sessions.observed.lock().unwrap().is_empty());
    assert!(world.upstream.requests.lock().unwrap().is_empty());
    world.facade.close().await;
}
