use axum::{Router, body::Bytes, extract::State, http::StatusCode, routing::post};
use ring::signature::{ECDSA_P256_SHA256_FIXED, UnparsedPublicKey};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicUsize, Ordering},
    },
};
use ycoding_core::remote::{CredentialState, Device, EnrollError, Enrollment, Error, FILE};

const CODE: &str = "ABCD-EFGH-JKLM-NPQR-STUV";
const NOW: u64 = 1_800_000_000_000;

#[derive(Default)]
struct Relay {
    requests: Mutex<Vec<(String, Value)>>,
    public_key: Mutex<Option<Value>>,
    challenges: Mutex<Vec<(String, String)>>,
    enroll_status: Mutex<Option<StatusCode>>,
    revoked: Mutex<bool>,
    issued: AtomicUsize,
}

impl Relay {
    async fn start() -> (Arc<Self>, String) {
        let relay = Arc::new(Self::default());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/api/devices/{operation}", post(handle))
            .with_state(relay.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (relay, origin)
    }

    fn operations(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|(operation, _)| operation.clone())
            .collect()
    }

    fn body(&self, operation: &str) -> Value {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(seen, _)| seen == operation)
            .unwrap()
            .1
            .clone()
    }

    fn tokens(&self) -> (StatusCode, String) {
        let index = self.issued.fetch_add(1, Ordering::AcqRel);
        (
            StatusCode::OK,
            json!({
                "accessToken": format!("access-secret-{index}"),
                "accessExpiresAt": NOW + 600_000,
                "refreshToken": format!("refresh-secret-{index}"),
                "refreshExpiresAt": NOW + 86_400_000,
            })
            .to_string(),
        )
    }
}

async fn handle(
    State(relay): State<Arc<Relay>>,
    axum::extract::Path(operation): axum::extract::Path<String>,
    body: Bytes,
) -> (StatusCode, String) {
    let body: Value = serde_json::from_slice(&body).unwrap();
    relay
        .requests
        .lock()
        .unwrap()
        .push((operation.clone(), body.clone()));
    if operation != "enroll" && *relay.revoked.lock().unwrap() {
        return (StatusCode::UNAUTHORIZED, "{}".into());
    }
    match operation.as_str() {
        "enroll" => {
            if let Some(status) = *relay.enroll_status.lock().unwrap() {
                return (status, "{\"error\":{\"code\":\"raw-relay-text\"}}".into());
            }
            *relay.public_key.lock().unwrap() = Some(body["publicKey"].clone());
            let id = relay.requests.lock().unwrap().len();
            (
                StatusCode::OK,
                json!({ "deviceID": format!("device-{id}") }).to_string(),
            )
        }
        "challenge" => {
            let challenge = (
                format!("challenge-{}", relay.challenges.lock().unwrap().len()),
                "nonce-value".to_owned(),
            );
            relay.challenges.lock().unwrap().push(challenge.clone());
            (
                StatusCode::OK,
                json!({ "challengeID": challenge.0, "nonce": challenge.1, "expiresAt": NOW + 60_000 })
                    .to_string(),
            )
        }
        "token" => {
            let key = relay.public_key.lock().unwrap().clone().unwrap();
            let mut point = vec![4];
            point.extend(base64url(key["x"].as_str().unwrap()));
            point.extend(base64url(key["y"].as_str().unwrap()));
            let challenge = relay.challenges.lock().unwrap().last().unwrap().clone();
            assert_eq!(body["challengeID"], challenge.0);
            let signature = base64url(body["signature"].as_str().unwrap());
            assert_eq!(signature.len(), 64);
            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
                .verify(
                    format!("ycoding-device-v1\n{}\n{}", challenge.0, challenge.1).as_bytes(),
                    &signature,
                )
                .unwrap();
            relay.tokens()
        }
        "refresh" => relay.tokens(),
        _ => (StatusCode::NOT_FOUND, "{}".into()),
    }
}

fn base64url(text: &str) -> Vec<u8> {
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = Vec::new();
    let mut bits = 0_u32;
    let mut count = 0;
    for byte in text.bytes() {
        bits = bits << 6 | alphabet.iter().position(|value| *value == byte).unwrap() as u32;
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
        }
    }
    bytes
}

fn state(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ycoding-remote-device-{label}-{}-{}",
        std::process::id(),
        NOW
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn enrollment(origin: &str, name: Option<&str>, replace: bool) -> Enrollment {
    Enrollment {
        relay_origin: origin.into(),
        enrollment_id: " enrollment-a ".into(),
        code: CODE.into(),
        name: name.map(str::to_owned),
        replace,
    }
}

fn stored(state: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(state.join(FILE)).unwrap()).unwrap()
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
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

#[tokio::test]
async fn enrollment_sends_the_relay_request_shape_and_persists_a_private_identity() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("enroll");
    let device = Device::new(&state).unwrap();
    assert_eq!(device.summary(NOW).await.unwrap(), None);
    assert_eq!(device.enrolled().await, Err(Error::NotEnrolled));

    let summary = device
        .enroll(
            enrollment(&format!("{origin}/"), Some("  Laptop  "), false),
            NOW,
        )
        .await
        .unwrap();
    assert_eq!(summary.device_id, "device-1");
    assert_eq!(summary.name, "Laptop");
    assert_eq!(summary.relay_origin, origin);
    assert_eq!(summary.enrolled_at, NOW);
    assert_eq!(summary.credential_state, CredentialState::NotAuthenticated);
    assert_eq!(summary.credential_expires_at, None);

    assert_eq!(relay.operations(), ["enroll"]);
    let body = relay.body("enroll");
    let mut keys = body
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, ["code", "enrollmentID", "name", "publicKey"]);
    assert_eq!(body["enrollmentID"], "enrollment-a");
    assert_eq!(body["code"], CODE);
    assert_eq!(body["name"], "Laptop");
    let public_key = body["publicKey"].as_object().unwrap();
    assert_eq!(public_key.len(), 4);
    assert_eq!(public_key["kty"], "EC");
    assert_eq!(public_key["crv"], "P-256");
    assert_eq!(public_key["x"].as_str().unwrap().len(), 43);
    assert_eq!(public_key["y"].as_str().unwrap().len(), 43);

    #[cfg(unix)]
    assert_eq!(mode(&state.join(FILE)), 0o600);
    let identity = stored(&state);
    let mut fields = identity
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    fields.sort();
    assert_eq!(
        fields,
        [
            "deviceID",
            "enrolledAt",
            "name",
            "privateKey",
            "publicKey",
            "relayURL"
        ]
    );
    assert_eq!(identity["deviceID"], "device-1");
    assert_eq!(identity["relayURL"], origin.as_str());
    assert_eq!(identity["enrolledAt"], NOW);
    assert_eq!(identity["publicKey"], body["publicKey"]);
    assert_eq!(identity["privateKey"]["x"], body["publicKey"]["x"]);
    assert_eq!(identity["privateKey"]["y"], body["publicKey"]["y"]);
    assert_eq!(identity["privateKey"]["d"].as_str().unwrap().len(), 43);
    assert_eq!(
        device.enrolled().await.unwrap(),
        (origin.clone(), "device-1".to_owned())
    );
    assert_eq!(
        std::fs::read_dir(&state).unwrap().count(),
        1,
        "the temporary file is renamed into place"
    );
}

#[tokio::test]
async fn an_identity_written_by_the_typescript_cli_is_read_and_reported() {
    logs();
    let state = state("typescript");
    let path = state.join(FILE);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    options
        .open(&path)
        .unwrap()
        .write_all(
            format!(
                "{{\"deviceID\":\"device-ts\",\"name\":\"Desk\",\"relayURL\":\"https://relay.example\",\"publicKey\":{{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"{key}\",\"y\":\"{key}\"}},\"privateKey\":{{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\"{key}\",\"y\":\"{key}\",\"d\":\"{key}\"}},\"refreshToken\":\"refresh-secret\",\"refreshExpiresAt\":{},\"enrolledAt\":1700000000000}}",
                NOW + 1
            )
            .as_bytes(),
        )
        .unwrap();
    let device = Device::new(&state).unwrap();
    let summary = device.summary(NOW).await.unwrap().unwrap();
    assert_eq!(summary.device_id, "device-ts");
    assert_eq!(summary.name, "Desk");
    assert_eq!(summary.relay_origin, "https://relay.example");
    assert_eq!(summary.enrolled_at, 1_700_000_000_000);
    assert_eq!(summary.credential_state, CredentialState::Valid);
    assert_eq!(summary.credential_expires_at, Some(NOW + 1));
    let expired = device.summary(NOW + 1).await.unwrap().unwrap();
    assert_eq!(expired.credential_state, CredentialState::Expired);
    assert_eq!(expired.credential_expires_at, Some(NOW + 1));
}

#[tokio::test]
async fn enrollment_failures_map_to_declared_codes_without_side_effects() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("failures");
    let device = Device::new(&state).unwrap();
    for invalid in [
        "http://relay.example",
        "https://relay.example/path",
        "https://user:secret@relay.example",
        "https://relay.example/?token=x",
        "relay.example",
    ] {
        assert_eq!(
            device.enroll(enrollment(invalid, None, false), NOW).await,
            Err(EnrollError::InvalidOrigin)
        );
    }
    for code in [
        "abcd-efgh-jkmn-pqrs-tuvw",
        "ABCD-EFGH-JKLM-NPQR",
        "ABCDEFGHJKLMNPQRSTUVWXYZ",
    ] {
        let mut input = enrollment(&origin, None, false);
        input.code = code.into();
        assert_eq!(
            device.enroll(input, NOW).await,
            Err(EnrollError::InvalidCode)
        );
    }
    assert!(relay.operations().is_empty());

    *relay.enroll_status.lock().unwrap() = Some(StatusCode::BAD_REQUEST);
    assert_eq!(
        device.enroll(enrollment(&origin, None, false), NOW).await,
        Err(EnrollError::RelayRejected)
    );
    *relay.enroll_status.lock().unwrap() = Some(StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        device.enroll(enrollment(&origin, None, false), NOW).await,
        Err(EnrollError::RelayUnavailable)
    );
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    assert_eq!(
        device.enroll(enrollment(&closed, None, false), NOW).await,
        Err(EnrollError::RelayUnavailable)
    );
    assert!(!state.join(FILE).exists());

    *relay.enroll_status.lock().unwrap() = None;
    let first = device
        .enroll(enrollment(&origin, None, false), NOW)
        .await
        .unwrap();
    assert!(!first.name.is_empty(), "the machine name is supplied");
    let before = std::fs::read(state.join(FILE)).unwrap();
    let requests = relay.operations().len();
    assert_eq!(
        device.enroll(enrollment(&origin, None, false), NOW).await,
        Err(EnrollError::AlreadyEnrolled)
    );
    assert_eq!(relay.operations().len(), requests);
    assert_eq!(std::fs::read(state.join(FILE)).unwrap(), before);
    let replaced = device
        .enroll(enrollment(&origin, Some("Replacement"), true), NOW + 5)
        .await
        .unwrap();
    assert_ne!(replaced.device_id, first.device_id);
    assert_eq!(stored(&state)["deviceID"], replaced.device_id.as_str());
    assert_eq!(stored(&state)["enrolledAt"], NOW + 5);
}

#[cfg(unix)]
#[tokio::test]
async fn local_persistence_failure_after_relay_enrollment_reports_the_redacted_device() {
    logs();
    use std::os::unix::fs::PermissionsExt;
    let (_relay, origin) = Relay::start().await;
    let state = state("partial");
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o500)).unwrap();
    let device = Device::new(&state).unwrap();
    let result = device
        .enroll(enrollment(&origin, Some("Laptop"), false), NOW)
        .await;
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    let Err(EnrollError::Partial(summary)) = result else {
        panic!("expected a partial failure");
    };
    assert_eq!(summary.device_id, "device-1");
    assert_eq!(summary.name, "Laptop");
    assert_eq!(summary.credential_state, CredentialState::NotAuthenticated);
    assert_eq!(std::fs::read_dir(&state).unwrap().count(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn shared_mode_and_symbolic_links_are_refused() {
    logs();
    use std::os::unix::fs::PermissionsExt;
    let (relay, origin) = Relay::start().await;
    let state = state("rules");
    let device = Device::new(&state).unwrap();
    device
        .enroll(enrollment(&origin, Some("Laptop"), false), NOW)
        .await
        .unwrap();
    let path = state.join(FILE);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(device.summary(NOW).await, Err(Error::Store));
    assert_eq!(device.enrolled().await, Err(Error::Store));
    assert!(matches!(device.access(NOW).await, Err(Error::Store)));
    let requests = relay.operations().len();
    assert_eq!(
        device
            .enroll(enrollment(&origin, Some("Laptop"), true), NOW)
            .await,
        Err(EnrollError::StoreFailed)
    );
    assert_eq!(relay.operations().len(), requests);

    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let target = state.join("elsewhere.json");
    std::fs::rename(&path, &target).unwrap();
    std::os::unix::fs::symlink(&target, &path).unwrap();
    assert_eq!(device.summary(NOW).await, Err(Error::Store));
    assert_eq!(
        device
            .enroll(enrollment(&origin, Some("Laptop"), true), NOW)
            .await,
        Err(EnrollError::StoreFailed)
    );
    assert!(
        std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(stored(&state)["deviceID"], "device-1");

    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, "{}").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(device.summary(NOW).await, Err(Error::Store));
}

#[tokio::test]
async fn credentials_sign_a_challenge_then_refresh_before_the_deadline_and_rotate() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("refresh");
    let device = Device::new(&state).unwrap();
    device
        .enroll(enrollment(&origin, Some("Laptop"), false), NOW)
        .await
        .unwrap();

    let first = device.access(NOW).await.unwrap();
    assert_eq!(first.token, "access-secret-0");
    assert_eq!(first.expires_at, NOW + 600_000);
    assert_eq!(first.device_id, "device-1");
    assert_eq!(first.relay_origin, origin);
    assert_eq!(relay.operations(), ["enroll", "challenge", "token"]);
    assert_eq!(relay.body("challenge"), json!({ "deviceID": "device-1" }));
    let mut token_fields = relay
        .body("token")
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    token_fields.sort();
    assert_eq!(token_fields, ["challengeID", "deviceID", "signature"]);
    assert_eq!(stored(&state)["refreshToken"], "refresh-secret-0");
    assert_eq!(stored(&state)["refreshExpiresAt"], NOW + 86_400_000);
    #[cfg(unix)]
    assert_eq!(mode(&state.join(FILE)), 0o600);
    let valid = device.summary(NOW).await.unwrap().unwrap();
    assert_eq!(valid.credential_state, CredentialState::Valid);
    assert_eq!(valid.credential_expires_at, Some(NOW + 86_400_000));

    let refreshed = device.access(NOW + 86_399_999).await.unwrap();
    assert_eq!(refreshed.token, "access-secret-1");
    assert_eq!(
        relay.operations(),
        ["enroll", "challenge", "token", "refresh"]
    );
    assert_eq!(
        relay.body("refresh"),
        json!({ "deviceID": "device-1", "refreshToken": "refresh-secret-0" })
    );
    assert_eq!(stored(&state)["refreshToken"], "refresh-secret-1");

    let deadline = NOW + 86_400_000;
    assert_eq!(
        device
            .summary(deadline)
            .await
            .unwrap()
            .unwrap()
            .credential_state,
        CredentialState::Expired
    );
    let reauthenticated = device.access(deadline).await.unwrap();
    assert_eq!(reauthenticated.token, "access-secret-2");
    assert_eq!(
        relay.operations()[4..],
        ["challenge".to_owned(), "token".to_owned()]
    );
}

#[tokio::test]
async fn relay_revocation_is_terminal_and_reported_until_a_new_enrollment() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("revoked");
    let device = Device::new(&state).unwrap();
    device
        .enroll(enrollment(&origin, Some("Laptop"), false), NOW)
        .await
        .unwrap();
    device.access(NOW).await.unwrap();
    *relay.revoked.lock().unwrap() = true;
    assert!(matches!(device.access(NOW).await, Err(Error::Revoked)));
    assert_eq!(relay.operations().last().unwrap(), "refresh");
    let revoked = device.summary(NOW).await.unwrap().unwrap();
    assert_eq!(revoked.credential_state, CredentialState::Revoked);
    assert_eq!(stored(&state)["refreshToken"], "refresh-secret-0");

    *relay.revoked.lock().unwrap() = false;
    let replaced = device
        .enroll(enrollment(&origin, Some("Laptop"), true), NOW)
        .await
        .unwrap();
    assert_eq!(replaced.credential_state, CredentialState::NotAuthenticated);
    assert_eq!(
        device.summary(NOW).await.unwrap().unwrap().credential_state,
        CredentialState::NotAuthenticated
    );
}

#[tokio::test]
async fn results_errors_and_logs_never_contain_secrets() {
    logs();
    let (relay, origin) = Relay::start().await;
    let state = state("secrets");
    let device = Device::new(&state).unwrap();
    let mut rendered = Vec::new();
    rendered.push(format!(
        "{:?}",
        device
            .enroll(enrollment(&origin, Some("Laptop"), false), NOW)
            .await
    ));
    rendered.push(format!(
        "{:?}",
        device
            .enroll(enrollment(&origin, Some("Laptop"), false), NOW)
            .await
    ));
    *relay.enroll_status.lock().unwrap() = Some(StatusCode::BAD_REQUEST);
    rendered.push(format!(
        "{:?}",
        device
            .enroll(enrollment(&origin, Some("Laptop"), true), NOW)
            .await
    ));
    let access = device.access(NOW).await.unwrap();
    assert!(access.token.starts_with("access-secret-"));
    *relay.revoked.lock().unwrap() = true;
    rendered.push(format!("{:?}", device.access(NOW).await.err()));
    rendered.push(format!("{:?}", device.summary(NOW).await));

    let identity = stored(&state);
    let secrets = [
        CODE.to_owned(),
        identity["privateKey"]["d"].as_str().unwrap().to_owned(),
        identity["publicKey"]["x"].as_str().unwrap().to_owned(),
        "refresh-secret".to_owned(),
        "access-secret".to_owned(),
        "raw-relay-text".to_owned(),
        "nonce-value".to_owned(),
    ];
    let logged = String::from_utf8(logs().0.lock().unwrap().clone()).unwrap();
    assert!(logged.contains("remote device enrolled"), "{logged}");
    assert!(logged.contains("reason=\"already_enrolled\""));
    assert!(logged.contains("reason=\"relay_rejected\""));
    assert!(logged.contains("remote relay no longer authorizes this device"));
    for secret in &secrets {
        assert!(!logged.contains(secret.as_str()), "log leaked {secret}");
        for result in &rendered {
            assert!(!result.contains(secret.as_str()), "result leaked {secret}");
        }
    }
}
