mod support;

use axum::{Router, body::Bytes, extract::State, http::StatusCode, routing::post};
use prost::{Message, Name};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use support::{machine, operation, services, text};
use ycoding_core::ycoding_schema::{JsonValue, parse_json};
use ycoding_protocol::{decode_strict, v5};
use ycoding_runtime::{
    Environment, LocalAuth, Settled, Subscriptions,
    connector::{Control, Credential, Credentials, Enrolled, Error, Peer},
    standard,
};

const CODE: &str = "ABCD-EFGH-JKLM-NPQR-STUV";

#[derive(Default)]
struct Relay {
    bodies: Mutex<Vec<String>>,
    status: Mutex<Option<StatusCode>>,
}

impl Relay {
    async fn start() -> (Arc<Self>, String) {
        let relay = Arc::new(Self::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/api/devices/enroll", post(enroll))
            .with_state(relay.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (relay, origin)
    }
}

async fn enroll(State(relay): State<Arc<Relay>>, body: Bytes) -> (StatusCode, String) {
    let mut bodies = relay.bodies.lock().unwrap();
    bodies.push(String::from_utf8(body.to_vec()).unwrap());
    if let Some(status) = *relay.status.lock().unwrap() {
        return (status, "{\"error\":\"raw-relay-text\"}".into());
    }
    (
        StatusCode::OK,
        format!("{{\"deviceID\":\"device-{}\"}}", bodies.len()),
    )
}

#[derive(Clone, Default)]
struct Logs(Arc<Mutex<Vec<u8>>>);

// One process-wide subscriber, installed before any test emits an event, so callsite interest cannot race.
fn logs() -> &'static Logs {
    static LOGS: OnceLock<Logs> = OnceLock::new();
    LOGS.get_or_init(|| {
        let logs = Logs::default();
        let writer = logs.clone();
        tracing::subscriber::set_global_default(
            tracing_subscriber::fmt()
                .with_writer(move || writer.clone())
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .finish(),
        )
        .unwrap();
        logs
    })
}

impl Write for Logs {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn state(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ycoding-remote-enroll-{label}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn environment(control: Control) -> Arc<Environment> {
    let mut services = services(LocalAuth::disabled(), true);
    services.core.as_mut().unwrap().remote = Some(control);
    Arc::new(Environment {
        services,
        urls: Vec::new(),
        subscriptions: Subscriptions::default(),
    })
}

fn request(name: &str, payload: Vec<u8>) -> v5::Request {
    v5::Request {
        request_id: "request-a".into(),
        operation_id: operation(name).operation_id,
        scope: machine(),
        payload,
    }
}

fn enrollment(origin: &str, code: &str, replace: bool) -> Vec<u8> {
    v5::RemoteEnrollRequest {
        payload: v5::RemoteEnrollRequestPayload {
            relay_origin: text(origin),
            enrollment_id: text("enrollment-a"),
            code: text(code),
            name: Some(text("Laptop")),
            replace: replace.then_some(true),
        },
    }
    .encode_to_vec()
}

fn outcome(settled: Option<Settled>) -> (v5::result::Outcome, Vec<u8>) {
    let Some(Settled::Result(result)) = settled else {
        panic!("expected inline result");
    };
    let bytes = result.encode_to_vec();
    (result.outcome.unwrap(), bytes)
}

fn success<T: Message + Name + Default>(settled: Option<Settled>) -> T {
    let (v5::result::Outcome::Success(payload), _) = outcome(settled) else {
        panic!("expected successful settlement");
    };
    assert_eq!(payload.type_name, T::full_name());
    decode_strict(&payload.payload).unwrap()
}

fn rejection(settled: Option<Settled>) -> v5::TypedPayload {
    let (v5::result::Outcome::Error(error), _) = outcome(settled) else {
        panic!("expected rejection");
    };
    error
}

fn enrollment_code(settled: Option<Settled>) -> i32 {
    let error = rejection(settled);
    assert_eq!(error.type_name, v5::RemoteEnrollmentError::full_name());
    let decoded: v5::RemoteEnrollmentError = decode_strict(&error.payload).unwrap();
    assert_eq!(decoded.tag, 1);
    decoded.code
}

fn object(text: &str) -> Vec<String> {
    let JsonValue::Object(object) = parse_json(text).unwrap() else {
        panic!("expected a JSON object");
    };
    let mut keys = object
        .iter()
        .map(|(key, _)| key.as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

#[tokio::test]
async fn local_enrollment_persists_and_remote_get_reports_the_redacted_device() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("success");
    let control = Control::open(&state).await.unwrap();
    let environment = environment(control.clone());
    let dispatcher = standard().unwrap();
    assert!(matches!(
        Credentials::enrolled(control.device()).await,
        Err(Error::Setup)
    ));

    let absent: v5::RemoteGetResult = success(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request("remote.get", Vec::new()),
            )
            .await,
    );
    assert_eq!(absent.data.state, 1);
    assert_eq!(absent.data.device, None);

    let (settled, result_bytes) = outcome(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request("remote.enroll", enrollment(&origin, CODE, false)),
            )
            .await,
    );
    let v5::result::Outcome::Success(payload) = settled else {
        panic!("expected enrollment to succeed");
    };
    assert_eq!(payload.type_name, v5::RemoteEnrollResult::full_name());
    let enrolled: v5::RemoteEnrollResult = decode_strict(&payload.payload).unwrap();
    let device = enrolled.data;
    assert_eq!(device.device_id, text("device-1"));
    assert_eq!(device.name, text("Laptop"));
    assert_eq!(device.relay_origin, text(&origin));
    assert!(device.enrolled_at > 0);
    assert_eq!(device.credential_state, 1);
    assert_eq!(device.credential_expires_at, None);

    let body = relay.bodies.lock().unwrap()[0].clone();
    assert_eq!(object(&body), ["code", "enrollmentID", "name", "publicKey"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(state.join("remote-device.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    assert!(
        !state.join("remote.json").exists(),
        "enrollment does not enable the connector"
    );

    let present: v5::RemoteGetResult = success(
        dispatcher
            .invoke(
                environment.clone(),
                "local".into(),
                request("remote.get", Vec::new()),
            )
            .await,
    );
    assert_eq!(present.data.state, 1);
    assert_eq!(present.data.device, Some(device));

    let enrolled = Credentials::enrolled(control.device()).await.unwrap();
    assert_eq!(
        enrolled.url(),
        format!("ws://{}/ws/v5/agent", origin.trim_start_matches("http://"))
    );

    let identity = std::fs::read_to_string(state.join("remote-device.json")).unwrap();
    let JsonValue::Object(stored) = parse_json(&identity).unwrap() else {
        panic!("expected a stored identity");
    };
    let secret = |key: &str, field: &str| {
        let JsonValue::Object(key) = stored.get(&key.into()).unwrap() else {
            panic!("expected a key");
        };
        let JsonValue::String(value) = key.get(&field.into()).unwrap() else {
            panic!("expected a coordinate");
        };
        value.as_str().unwrap().to_owned()
    };
    let logged = String::from_utf8(logs().0.lock().unwrap().clone()).unwrap();
    assert!(logged.contains("remote device enrolled"));
    for value in [
        CODE.to_owned(),
        secret("privateKey", "d"),
        secret("publicKey", "x"),
        secret("publicKey", "y"),
    ] {
        assert!(!logged.contains(&value));
        for bytes in [&result_bytes, &present.encode_to_vec()] {
            assert!(
                !bytes
                    .windows(value.len())
                    .any(|window| window == value.as_bytes()),
                "result leaked a secret"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enrollment_failures_settle_with_declared_codes_and_stay_local_only() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("failures");
    let control = Control::open(&state).await.unwrap();
    let environment = environment(control.clone());
    let dispatcher = standard().unwrap();
    let invoke = |payload| {
        let environment = environment.clone();
        let dispatcher = &dispatcher;
        async move {
            dispatcher
                .invoke(
                    environment,
                    "local".into(),
                    request("remote.enroll", payload),
                )
                .await
        }
    };

    assert_eq!(
        enrollment_code(invoke(enrollment("http://relay.example", CODE, false)).await),
        1
    );
    assert_eq!(
        enrollment_code(invoke(enrollment(&origin, "not-a-code", false)).await),
        2
    );
    assert!(relay.bodies.lock().unwrap().is_empty());
    *relay.status.lock().unwrap() = Some(StatusCode::FORBIDDEN);
    assert_eq!(
        enrollment_code(invoke(enrollment(&origin, CODE, false)).await),
        4
    );
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    assert_eq!(
        enrollment_code(invoke(enrollment(&closed, CODE, false)).await),
        5
    );
    *relay.status.lock().unwrap() = None;
    let _: v5::RemoteEnrollResult = success(invoke(enrollment(&origin, CODE, false)).await);
    assert_eq!(
        enrollment_code(invoke(enrollment(&origin, CODE, false)).await),
        3
    );
    let replaced: v5::RemoteEnrollResult = success(invoke(enrollment(&origin, CODE, true)).await);
    assert_eq!(replaced.data.device_id, text("device-3"));

    let peer = Peer::authenticate(
        &Enrolled::new("https://relay.invalid", "device-a".into()).unwrap(),
        &Credential::new(
            "stand-in-token".into(),
            i64::MAX,
            "https://relay.invalid".into(),
            "device-a".into(),
        ),
        0,
    )
    .unwrap();
    assert!(
        dispatcher
            .invoke_remote(
                environment.clone(),
                "remote".into(),
                &peer,
                request("remote.enroll", enrollment(&origin, CODE, true)),
            )
            .await
            .is_none()
    );
    assert_eq!(relay.bodies.lock().unwrap().len(), 3);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistence_failure_after_relay_enrollment_returns_the_partial_device() {
    logs();
    use std::os::unix::fs::PermissionsExt;
    let (_relay, origin) = Relay::start().await;
    let state = state("partial");
    let control = Control::open(&state).await.unwrap();
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o500)).unwrap();
    let settled = standard()
        .unwrap()
        .invoke(
            environment(control),
            "local".into(),
            request("remote.enroll", enrollment(&origin, CODE, false)),
        )
        .await;
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    let error = rejection(settled);
    assert_eq!(
        error.type_name,
        v5::RemoteEnrollmentPartialFailure::full_name()
    );
    let partial: v5::RemoteEnrollmentPartialFailure = decode_strict(&error.payload).unwrap();
    assert_eq!(partial.tag, 1);
    assert_eq!(partial.device.device_id, text("device-1"));
    assert_eq!(partial.device.credential_state, 1);
    assert!(!Path::new(&state).join("remote-device.json").exists());
}
