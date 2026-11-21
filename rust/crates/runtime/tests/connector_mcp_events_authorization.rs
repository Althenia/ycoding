use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
};
use ycoding_core::{
    mcp_events::{
        Authorization, Cancellation, HttpResponse, ResultFuture,
        authorization::{self, Http},
    },
    ycoding_schema::{
        DomainDecode, JsonValue,
        mcp_events::{Principal, RequestContext},
        parse_json,
    },
};
use ycoding_runtime::{
    Boxed,
    connector::{
        Credential, Credentials, Enrolled, Error, Peer,
        mcp::Lease,
        mcp_events_authorization::{Authorizer, Dependencies},
    },
};

const NOW: i64 = 1_900_000_000_000;

struct DeviceAccess {
    expires: AtomicI64,
    origin: Mutex<String>,
    enrollment: Mutex<(String, String)>,
    acquisitions: AtomicUsize,
}
impl Credentials for DeviceAccess {
    fn enrolled(&self) -> Boxed<Result<Enrolled, Error>> {
        let enrollment = self.enrollment.lock().unwrap().clone();
        Box::pin(async move { Enrolled::new(&enrollment.0, enrollment.1) })
    }
    fn access(&self) -> Boxed<Result<Credential, Error>> {
        let expires = self.expires.load(Ordering::Acquire);
        let origin = self.origin.lock().unwrap().clone();
        let acquisition = self.acquisitions.fetch_add(1, Ordering::AcqRel);
        Box::pin(async move {
            Ok(Credential::new(
                if acquisition == 0 {
                    "synthetic-bearer".into()
                } else {
                    format!("synthetic-bearer-{acquisition}")
                },
                expires,
                origin,
                "device_synthetic".into(),
            ))
        })
    }
}

struct Relay {
    requests: Mutex<Vec<authorization::Request>>,
    response: Mutex<(u16, String)>,
    blocked: AtomicBool,
    entered: tokio::sync::Notify,
    released: tokio::sync::Notify,
}
impl Http for Relay {
    fn post(
        &self,
        request: authorization::Request,
        cancellation: Cancellation,
    ) -> ResultFuture<'_, HttpResponse> {
        Box::pin(async move {
            self.requests.lock().unwrap().push(request);
            self.entered.notify_one();
            if self.blocked.load(Ordering::Acquire) {
                tokio::select! {
                    _ = cancellation.cancelled() => {},
                    _ = self.released.notified() => {},
                }
            }
            let reply = self.response.lock().unwrap();
            Ok(HttpResponse {
                status: reply.0,
                body: reply.1.clone(),
            })
        })
    }
}

struct Fixture {
    authorizer: Arc<Authorizer>,
    credentials: Arc<DeviceAccess>,
    relay: Arc<Relay>,
    lease: Lease,
    enabled: Arc<AtomicBool>,
    clock: Arc<AtomicI64>,
}
impl Fixture {
    fn new() -> Self {
        let credentials = Arc::new(DeviceAccess {
            expires: AtomicI64::new(NOW + 600_000),
            origin: Mutex::new("https://relay.invalid".into()),
            enrollment: Mutex::new(("https://relay.invalid".into(), "device_synthetic".into())),
            acquisitions: AtomicUsize::new(0),
        });
        let enrolled = Enrolled::new("https://relay.invalid", "device_synthetic".into()).unwrap();
        let peer = Peer::authenticate(
            &enrolled,
            &Credential::new(
                "synthetic-bearer".into(),
                NOW + 600_000,
                "https://relay.invalid".into(),
                "device_synthetic".into(),
            ),
            NOW,
        )
        .unwrap();
        let lease = Lease::new(
            peer,
            "connection_synthetic".into(),
            "epoch_synthetic".into(),
        )
        .unwrap();
        let enabled = Arc::new(AtomicBool::new(true));
        let relay=Arc::new(Relay{requests:Mutex::new(vec![]),response:Mutex::new((200,r#"{"action":"resolve","authorized":true,"grantID":"grant_exact","expiresAt":1900001000000}"#.into())),blocked:AtomicBool::new(false),entered:tokio::sync::Notify::new(),released:tokio::sync::Notify::new()});
        let clock = Arc::new(AtomicI64::new(NOW));
        let authorizer = Arc::new(Authorizer::new(Dependencies {
            credentials: credentials.clone(),
            http: relay.clone(),
            clock: {
                let clock = clock.clone();
                Arc::new(move || clock.load(Ordering::Acquire))
            },
            lease: {
                let lease = lease.clone();
                let enabled = enabled.clone();
                Arc::new(move |epoch: Option<&str>| {
                    (enabled.load(Ordering::Acquire)
                        && epoch.is_none_or(|epoch| epoch == "epoch_synthetic"))
                    .then(|| lease.clone())
                })
            },
        }));
        Self {
            authorizer,
            credentials,
            relay,
            lease,
            enabled,
            clock,
        }
    }
}

fn context() -> RequestContext {
    RequestContext::decode(&parse_json(r#"{"requestID":"outer_forwarded_request","principal":{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"https://client.invalid/manifest"},"epoch":"epoch_synthetic"}"#).unwrap()).unwrap()
}
fn principal() -> Principal {
    Principal::decode(&parse_json(r#"{"ownerID":"owner_synthetic","deviceID":"device_synthetic","clientID":"https://client.invalid/manifest","grantID":"grant_exact","epoch":"epoch_synthetic"}"#).unwrap()).unwrap()
}
fn field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    match value {
        JsonValue::Object(object) => object.get(&name.into()),
        _ => None,
    }
}

#[tokio::test]
async fn rotating_credentials_are_acquired_once_per_authority_request() {
    let fixture = Fixture::new();
    for (index, action) in ["capabilities", "resolve", "check"].into_iter().enumerate() {
        *fixture.relay.response.lock().unwrap() = (200, match action {
            "capabilities" => r#"{"action":"capabilities","supported":true}"#,
            "resolve" => r#"{"action":"resolve","authorized":true,"grantID":"grant_exact","expiresAt":1900001000000}"#,
            _ => r#"{"action":"check","authorized":true,"grantID":"grant_exact","expiresAt":1900001000000}"#,
        }.into());
        match action {
            "capabilities" => assert!(
                fixture
                    .authorizer
                    .capabilities(Cancellation::default())
                    .await
                    .unwrap()
            ),
            "resolve" => assert_eq!(
                fixture
                    .authorizer
                    .resolve(context(), Cancellation::default())
                    .await
                    .unwrap()
                    .grant_id
                    .as_str(),
                Some("grant_exact")
            ),
            _ => assert!(
                !fixture
                    .authorizer
                    .check(principal(), Cancellation::default())
                    .await
                    .unwrap()
                    .cancellation
                    .is_cancelled()
            ),
        }
        assert_eq!(
            fixture.credentials.acquisitions.load(Ordering::Acquire),
            index + 1
        );
        assert_eq!(fixture.relay.requests.lock().unwrap().len(), index + 1);
    }
    assert_eq!(
        fixture
            .relay
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.bearer.as_str())
            .collect::<Vec<_>>(),
        vec![
            "synthetic-bearer",
            "synthetic-bearer-1",
            "synthetic-bearer-2"
        ]
    );
}

#[tokio::test]
async fn pending_authority_requests_recheck_enrollment_original_expiry_and_enabled_lease() {
    for change in ["origin", "device", "expiry", "disabled"] {
        let fixture = Fixture::new();
        fixture.relay.blocked.store(true, Ordering::Release);
        let task = tokio::spawn({
            let authorizer = fixture.authorizer.clone();
            async move { authorizer.resolve(context(), Cancellation::default()).await }
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            fixture.relay.entered.notified(),
        )
        .await
        .unwrap();
        match change {
            "origin" => {
                fixture.credentials.enrollment.lock().unwrap().0 = "https://other.invalid".into()
            }
            "device" => fixture.credentials.enrollment.lock().unwrap().1 = "other_device".into(),
            "expiry" => fixture.clock.store(NOW + 600_000, Ordering::Release),
            _ => fixture.enabled.store(false, Ordering::Release),
        }
        fixture.relay.released.notify_one();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap()
                .is_err(),
            "{change}"
        );
        assert_eq!(
            fixture.credentials.acquisitions.load(Ordering::Acquire),
            1,
            "{change}"
        );
        assert_eq!(fixture.relay.requests.lock().unwrap().len(), 1, "{change}");
    }
}

#[tokio::test]
async fn exact_grant_resolution_uses_only_the_fixed_device_authority_endpoint_and_outer_request_id()
{
    let fixture = Fixture::new();
    let result = fixture
        .authorizer
        .resolve(context(), Cancellation::default())
        .await
        .unwrap();
    assert_eq!(result.grant_id.as_str(), Some("grant_exact"));
    assert_eq!(result.expires_at, NOW + 1_000_000);
    let requests = fixture.relay.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url,
        "https://relay.invalid/api/devices/device_synthetic/mcp/events/authorize"
    );
    assert_eq!(requests[0].bearer, "synthetic-bearer");
    let body = parse_json(&requests[0].body).unwrap();
    assert_eq!(
        field(&body, "action"),
        Some(&JsonValue::String("resolve".into()))
    );
    assert_eq!(
        field(&body, "requestID"),
        Some(&JsonValue::String("outer_forwarded_request".into()))
    );
    assert!(field(&body, "grantID").is_none());
    assert!(field(&body, "resource").is_none());
    let Some(JsonValue::Object(principal)) = field(&body, "principal") else {
        panic!("principal")
    };
    assert_eq!(principal.len(), 3);
    assert!(!requests[0].body.contains("synthetic-bearer"));
}

#[tokio::test]
async fn capability_and_check_requests_preserve_the_pinned_closed_bodies_and_exact_grant() {
    let fixture = Fixture::new();
    *fixture.relay.response.lock().unwrap() =
        (200, r#"{"action":"capabilities","supported":true}"#.into());
    assert!(
        fixture
            .authorizer
            .capabilities(Cancellation::default())
            .await
            .unwrap()
    );
    assert_eq!(
        parse_json(&fixture.relay.requests.lock().unwrap()[0].body).unwrap(),
        parse_json(r#"{"action":"capabilities"}"#).unwrap()
    );
    *fixture.relay.response.lock().unwrap() = (
        200,
        r#"{"action":"check","authorized":true,"grantID":"grant_exact","expiresAt":1900001000000}"#
            .into(),
    );
    let permit = fixture
        .authorizer
        .check(principal(), Cancellation::default())
        .await
        .unwrap();
    assert!(!permit.cancellation.is_cancelled());
    let body = parse_json(&fixture.relay.requests.lock().unwrap()[1].body).unwrap();
    assert_eq!(
        field(&body, "grantID"),
        Some(&JsonValue::String("grant_exact".into()))
    );
    assert!(field(&body, "requestID").is_none());
    fixture.lease.revoke();
    assert!(permit.cancellation.is_cancelled());
}

#[tokio::test]
async fn expired_credentials_wrong_enrollment_device_epoch_or_disabled_state_never_send_authorization()
 {
    for mode in [
        "expired", "origin", "device", "epoch", "disabled", "revoked",
    ] {
        let fixture = Fixture::new();
        let mut context = context();
        match mode {
            "expired" => fixture.credentials.expires.store(NOW, Ordering::Release),
            "origin" => {
                *fixture.credentials.origin.lock().unwrap() = "https://other.invalid".into()
            }
            "device" => context.principal.device_id = "other_device".into(),
            "epoch" => context.epoch = "epoch_other".into(),
            "disabled" => fixture.enabled.store(false, Ordering::Release),
            _ => fixture.lease.revoke(),
        }
        assert!(
            fixture
                .authorizer
                .resolve(context, Cancellation::default())
                .await
                .is_err(),
            "{mode}"
        );
        assert!(fixture.relay.requests.lock().unwrap().is_empty(), "{mode}");
    }
}

#[tokio::test]
async fn replacement_grants_malformed_responses_and_denials_never_become_active_authority() {
    for body in [
        r#"{"action":"check","authorized":true,"grantID":"grant_replacement","expiresAt":1900001000000}"#,
        r#"{"action":"resolve","authorized":true,"grantID":"grant_exact","expiresAt":1900001000000}"#,
        r#"{"action":"check","authorized":true,"grantID":"grant_exact","expiresAt":1900000000000}"#,
        r#"{"action":"check","authorized":true,"grantID":"grant_exact","expiresAt":9007199254740992}"#,
        r#"{"action":"check","authorized":true,"grantID":"grant_exact","expiresAt":1900001000000,"token":"untrusted"}"#,
        r#"{"action":"check","authorized":false,"reason":"forbidden"}"#,
        r#"{"action":"check","authorized":false,"reason":"not_found"}"#,
        r#"{"action":"check","authorized":false,"reason":"unavailable"}"#,
    ] {
        let fixture = Fixture::new();
        *fixture.relay.response.lock().unwrap() = (200, body.into());
        assert!(
            fixture
                .authorizer
                .check(principal(), Cancellation::default())
                .await
                .is_err(),
            "{body}"
        );
    }
    for status in [401, 403, 404, 429, 500] {
        let fixture = Fixture::new();
        fixture.relay.response.lock().unwrap().0 = status;
        assert!(
            fixture
                .authorizer
                .resolve(context(), Cancellation::default())
                .await
                .is_err()
        );
    }
    let fixture = Fixture::new();
    *fixture.relay.response.lock().unwrap() = (200, "x".repeat(8193));
    assert!(
        fixture
            .authorizer
            .resolve(context(), Cancellation::default())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn authority_loss_or_request_cancellation_while_resolving_refuses_the_late_result() {
    for loss in ["request", "lease"] {
        let fixture = Fixture::new();
        fixture.relay.blocked.store(true, Ordering::Release);
        let cancellation = Cancellation::default();
        let task = tokio::spawn({
            let authorizer = fixture.authorizer.clone();
            let cancellation = cancellation.clone();
            async move { authorizer.resolve(context(), cancellation).await }
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            fixture.relay.entered.notified(),
        )
        .await
        .unwrap();
        if loss == "request" {
            cancellation.cancel();
        } else {
            fixture.lease.revoke();
        }
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(3), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
    }
}
