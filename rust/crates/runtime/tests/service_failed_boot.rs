mod launcher {
    include!("support/launcher.rs");
    impl Runtime {
        pub fn stdout(&mut self) -> Vec<String> {
            assert!(self.child.try_wait().unwrap().is_some());
            if let Some(reader) = self.reader.take() {
                reader.join().unwrap();
            }
            self.lines.try_iter().collect()
        }
    }
}

use launcher::{Directory, Runtime, read, string};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::Command,
    time::Duration,
};
use ycoding_core::ycoding_schema::{JsonObject, JsonValue, parse_json, stringify_json};

const VERSION: &str = "native-failed-boot-test";
const PASSWORD: &str = "synthetic-service-password";

enum BootFailure {
    Store,
    Composition,
}

struct FailedService {
    runtime: Runtime,
    directory: Directory,
    info: JsonValue,
    url: String,
    startup_error: PathBuf,
}

impl FailedService {
    fn start(failure: BootFailure) -> Self {
        let directory = Directory::new();
        let available = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = available.local_addr().unwrap().port();
        drop(available);
        configure_service(&directory, port);
        let startup_error = directory.0.join("startup-error.txt");
        let mut command = command(&directory, &startup_error);
        match failure {
            BootFailure::Store => {
                let invalid = directory.0.join("invalid-store");
                std::fs::create_dir_all(&invalid).unwrap();
                command.env("YCODING_DB", invalid);
            }
            BootFailure::Composition => {
                fail_composition(&directory, &mut command);
            }
        }
        let runtime = Runtime::spawn(command, &["serve", "--service"]);
        Self::registered(runtime, directory, port, startup_error)
    }

    fn registered(
        mut runtime: Runtime,
        directory: Directory,
        port: u16,
        startup_error: PathBuf,
    ) -> Self {
        let registration = directory.registration("local");
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let info = loop {
            match std::fs::metadata(&registration) {
                Ok(_) => break read(&registration),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    assert!(runtime.child.try_wait().unwrap().is_none());
                    assert!(
                        std::time::Instant::now() < deadline,
                        "native registration was not published"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("native registration could not be read: {error}"),
            }
        };
        let url = string(&info, "url");
        assert_eq!(url, format!("http://127.0.0.1:{port}"));
        assert_eq!(string(&info, "version"), VERSION);
        assert_eq!(string(&info, "password"), PASSWORD);
        assert_eq!(
            field(&info, "pid"),
            &JsonValue::Number(f64::from(runtime.child.id()))
        );
        assert!(!string(&info, "id").is_empty());
        Self {
            runtime,
            directory,
            info,
            url,
            startup_error,
        }
    }

    fn assert_status(&mut self, expected: u16) {
        for path in ["/health", "/api/health"] {
            let response = request(&self.url, path, Some(PASSWORD), None);
            self.assert_response(expected, response);
        }
    }

    fn assert_response(&mut self, expected: u16, response: (u16, String, String)) {
        let (status, body, headers) = response;
        assert!(self.runtime.child.try_wait().unwrap().is_none());
        assert_eq!(status, expected, "{body}");
        if expected == 503 {
            assert!(
                headers.lines().any(|line| {
                    line.split_once(':').is_some_and(|(name, value)| {
                        name.eq_ignore_ascii_case("retry-after") && value.trim() == "1"
                    })
                }),
                "{headers}"
            );
        }
        let health = parse_json(&body).unwrap();
        assert_eq!(field(&health, "healthy"), &JsonValue::Bool(true));
        assert_eq!(string(&health, "version"), VERSION);
        assert_eq!(field(&health, "pid"), field(&self.info, "pid"));
        assert_eq!(string(&health, "sourceEpoch"), string(&self.info, "id"));
        let error = TcpListener::bind(address(&self.url)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
    }

    async fn wait_for_failed(&mut self) {
        tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let (status, body, headers) =
                    request(&self.url, "/api/health", Some(PASSWORD), None);
                match status {
                    500 => {
                        self.assert_response(500, (status, body, headers));
                        break;
                    }
                    503 => {
                        self.assert_response(503, (status, body, headers));
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    _ => panic!("expected starting503 or failed500, received {status}: {body}"),
                }
            }
        })
        .await
        .expect("native service did not publish its genuine boot failure");
        self.assert_status(500);
    }

    fn wait_and_diagnostics(&mut self) -> String {
        let status = self.runtime.wait();
        assert!(status.code().is_some(), "{status}");
        assert_eq!(self.runtime.stdout(), Vec::<String>::new());
        let mut diagnostic = String::new();
        self.runtime
            .child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut diagnostic)
            .unwrap();
        diagnostic
    }
}

fn configure_service(directory: &Directory, port: u16) {
    let configuration = directory.0.join("config/ycoding/service-local.json");
    std::fs::create_dir_all(configuration.parent().unwrap()).unwrap();
    std::fs::write(
        configuration,
        format!(r#"{{"port":{port},"password":"{PASSWORD}"}}"#),
    )
    .unwrap();
}

fn fail_composition(directory: &Directory, command: &mut Command) {
    let mut configuration = JsonObject::new();
    configuration.insert(
        "model".into(),
        JsonValue::String(
            format!(
                "{{file:{}}}",
                directory.0.join("missing-model.txt").display()
            )
            .into(),
        ),
    );
    command.env(
        "YCODING_CONFIG_CONTENT",
        stringify_json(&JsonValue::Object(configuration)),
    );
}

fn command(directory: &Directory, startup_error: &std::path::Path) -> Command {
    let mut command = directory.command(VERSION, "local");
    command
        .current_dir(&directory.0)
        .env_remove("YCODING_DB")
        .env_remove("YCODING_DISABLE_CHANNEL_DB")
        .env("YCODING_SERVICE_STARTUP_ERROR_FILE", startup_error);
    command
}

fn field<'a>(value: &'a JsonValue, key: &str) -> &'a JsonValue {
    let JsonValue::Object(object) = value else {
        panic!("expected object");
    };
    object.get(&key.into()).unwrap()
}

fn address(url: &str) -> SocketAddr {
    url.strip_prefix("http://").unwrap().parse().unwrap()
}

fn request(
    url: &str,
    path: &str,
    password: Option<&str>,
    body: Option<&str>,
) -> (u16, String, String) {
    let address = address(url);
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(10)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    let auth = password
        .map(|password| {
            format!(
                "Authorization: Basic {}\r\n",
                base64(format!("ycoding:{password}").as_bytes())
            )
        })
        .unwrap_or_default();
    let method = if body.is_some() { "POST" } else { "GET" };
    let body = body.unwrap_or("");
    write!(stream, "{method} {path} HTTP/1.1\r\nHost: {address}\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    (
        response.split_whitespace().nth(1).unwrap().parse().unwrap(),
        response.split_once("\r\n\r\n").unwrap().1.into(),
        response.split_once("\r\n\r\n").unwrap().0.into(),
    )
}

fn base64(input: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    input
        .chunks(3)
        .flat_map(|chunk| {
            let value = chunk.iter().enumerate().fold(0u32, |value, (i, byte)| {
                value | (u32::from(*byte) << (16 - 8 * i))
            });
            (0..4).map(move |i| {
                if i > chunk.len() {
                    '='
                } else {
                    ABC[((value >> (18 - 6 * i)) & 63) as usize] as char
                }
            })
        })
        .collect()
}

async fn assert_port_released(url: &str) {
    let listener = tokio::net::TcpListener::bind(address(url)).await.unwrap();
    assert_eq!(listener.local_addr().unwrap(), address(url));
}

#[tokio::test]
async fn failed_store_boot_retains_native_owner_until_authenticated_exact_instance_stop() {
    let mut service = FailedService::start(BootFailure::Store);
    service.wait_for_failed().await;
    let registration = service.directory.registration("local");
    let original = std::fs::read(&registration).unwrap();
    let error = std::fs::read_to_string(&service.startup_error).unwrap();
    assert!(error.contains("YCODING_DB:"), "{error}");
    assert!(error.contains("not a regular file"), "{error}");

    for password in [None, Some("wrong-synthetic-password")] {
        for path in ["/health", "/api/health"] {
            assert_eq!(request(&service.url, path, password, None).0, 401);
        }
        assert_eq!(
            request(&service.url, "/api/service/stop", password, Some("{}")).0,
            401
        );
    }
    assert_eq!(
        request(
            &service.url,
            "/api/service/stop",
            Some(PASSWORD),
            Some("{}")
        )
        .0,
        400
    );
    let (status, body, _) = request(
        &service.url,
        "/api/service/stop",
        Some(PASSWORD),
        Some(r#"{"instanceID":"stale-native-instance"}"#),
    );
    assert_eq!(status, 200);
    assert_eq!(
        field(&parse_json(&body).unwrap(), "accepted"),
        &JsonValue::Bool(false)
    );
    service.assert_status(500);
    assert_eq!(std::fs::read(&registration).unwrap(), original);

    let mut contender_command = command(&service.directory, &service.startup_error);
    contender_command.env("YCODING_DB", service.directory.0.join("invalid-store"));
    let mut contender = Runtime::spawn(contender_command, &["serve", "--service"]);
    assert_eq!(contender.wait().code(), Some(0));
    assert_eq!(contender.stdout(), Vec::<String>::new());
    assert_eq!(std::fs::read(&registration).unwrap(), original);
    assert_eq!(
        std::fs::read_to_string(&service.startup_error).unwrap(),
        error
    );
    service.assert_status(500);

    let body = format!(r#"{{"instanceID":"{}"}}"#, string(&service.info, "id"));
    let (status, body, _) = request(
        &service.url,
        "/api/service/stop",
        Some(PASSWORD),
        Some(&body),
    );
    assert_eq!(status, 200);
    assert_eq!(
        field(&parse_json(&body).unwrap(), "accepted"),
        &JsonValue::Bool(true)
    );
    let diagnostic = service.wait_and_diagnostics();
    assert!(diagnostic.contains("YCODING_DB:"), "{diagnostic}");
    assert!(!registration.exists());
    assert_port_released(&service.url).await;
    assert!(service.directory.0.join("invalid-store").is_dir());
}

#[tokio::test]
async fn failed_composition_registration_deletion_stops_owner_and_releases_listener() {
    let mut service = FailedService::start(BootFailure::Composition);
    service.wait_for_failed().await;
    let error = std::fs::read_to_string(&service.startup_error).unwrap();
    assert!(error.contains("production composition failed"), "{error}");
    let registration = service.directory.registration("local");
    std::fs::remove_file(&registration).unwrap();
    let diagnostic = service.wait_and_diagnostics();
    assert!(
        diagnostic.contains("production composition failed"),
        "{diagnostic}"
    );
    assert!(
        diagnostic.contains(
            "production composition diagnostic: stage=global configuration; category=unavailable"
        ),
        "{diagnostic}"
    );
    assert!(!diagnostic.contains(&service.directory.0.display().to_string()));
    assert!(!registration.exists());
    assert_port_released(&service.url).await;
}

#[tokio::test]
async fn foreign_registration_replacement_retires_failed_owner_without_removing_replacement() {
    for signal in [None, Some("-TERM")] {
        if signal.is_some() && !cfg!(unix) {
            continue;
        }
        let mut service = FailedService::start(BootFailure::Store);
        service.wait_for_failed().await;
        let JsonValue::Object(mut replacement) = service.info.clone() else {
            panic!("expected registration object");
        };
        replacement.insert(
            "id".into(),
            JsonValue::String("foreign-native-instance".into()),
        );
        let replacement = stringify_json(&JsonValue::Object(replacement));
        let registration = service.directory.registration("local");
        std::fs::write(&registration, &replacement).unwrap();
        if let Some(signal) = signal {
            service.runtime.signal(signal);
        }
        service.wait_and_diagnostics();
        assert_eq!(std::fs::read_to_string(registration).unwrap(), replacement);
        assert_port_released(&service.url).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn foreign_failed_health_with_wrong_epoch_cannot_claim_stale_registration() {
    use axum::{http::StatusCode, response::IntoResponse};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    let directory = Directory::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let url = format!("http://{address}");
    configure_service(&directory, address.port());
    let registration = directory.registration("local");
    std::fs::create_dir_all(registration.parent().unwrap()).unwrap();
    let pid = std::process::id();
    let original = format!(
        r#"{{"id":"stale-registration-epoch","version":"{VERSION}","pid":{pid},"url":"{url}","password":"{PASSWORD}"}}"#
    );
    std::fs::write(&registration, &original).unwrap();
    let body = format!(
        r#"{{"healthy":true,"version":"{VERSION}","pid":{pid},"sourceEpoch":"foreign-live-epoch"}}"#
    );
    let authenticated = Arc::new(AtomicBool::new(false));
    let observed = authenticated.clone();
    let router = axum::Router::new().route(
        "/api/health",
        axum::routing::get(move |headers: axum::http::HeaderMap| {
            let body = body.clone();
            let observed = observed.clone();
            async move {
                if !ycoding_runtime::LocalAuth::with_password(PASSWORD).authorized(&headers) {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                observed.store(true, Ordering::Release);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    [("content-type", "application/json")],
                    body,
                )
                    .into_response()
            }
        }),
    );
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let foreign = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });
    let startup_error = directory.0.join("startup-error.txt");
    let mut contender_command = command(&directory, &startup_error);
    let invalid = directory.0.join("invalid-store");
    std::fs::create_dir_all(&invalid).unwrap();
    contender_command.env("YCODING_DB", invalid);
    let mut contender = Runtime::spawn(contender_command, &["serve", "--service"]);
    let status = contender.wait();
    assert_eq!(contender.stdout(), Vec::<String>::new());
    let native_authenticated = authenticated.load(Ordering::Acquire);
    let preserved = std::fs::read_to_string(&registration).unwrap();
    let still_bound = TcpListener::bind(address).unwrap_err().kind();
    let (foreign_status, foreign_body, _) = request(&url, "/api/health", Some(PASSWORD), None);
    stop.send(()).unwrap();
    foreign.await.unwrap();

    assert!(
        native_authenticated,
        "native contender did not authenticate its incumbent probe"
    );
    assert_eq!(status.code(), Some(1));
    assert_eq!(preserved, original);
    assert_eq!(std::fs::read_to_string(registration).unwrap(), original);
    assert_eq!(still_bound, std::io::ErrorKind::AddrInUse);
    assert_eq!(foreign_status, 500);
    assert_eq!(
        string(&parse_json(&foreign_body).unwrap(), "sourceEpoch"),
        "foreign-live-epoch"
    );
    assert_port_released(&url).await;
}

#[cfg(unix)]
#[tokio::test]
async fn starting_native_owner_admits_contender_while_real_catalog_read_is_gated() {
    let directory = Directory::new();
    let available = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = available.local_addr().unwrap().port();
    drop(available);
    configure_service(&directory, port);
    let fifo = directory.0.join("gated-models.json");
    assert!(
        Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let mut gate = Runtime::spawn(
        Command::new("sh"),
        &[
            "-c",
            "exec 3>\"$1\"; printf 'catalog-reader-attached\\n'; IFS= read -r release; printf '{}' >&3; exec 3>&-",
            "catalog-gate",
            fifo.to_str().unwrap(),
        ],
    );
    let startup_error = directory.0.join("startup-error.txt");
    let mut owner_command = command(&directory, &startup_error);
    fail_composition(&directory, &mut owner_command);
    owner_command.env("YCODING_MODELS_PATH", &fifo);
    let runtime = Runtime::spawn(owner_command, &["serve", "--service"]);
    assert_eq!(gate.ready(), "catalog-reader-attached");
    let mut service = FailedService::registered(runtime, directory, port, startup_error);
    service.assert_status(503);
    assert!(!service.startup_error.exists());
    for password in [None, Some("wrong-synthetic-password")] {
        assert_eq!(request(&service.url, "/api/health", password, None).0, 401);
        assert_eq!(
            request(&service.url, "/api/service/stop", password, Some("{}")).0,
            401
        );
    }
    let registration = service.directory.registration("local");
    let original = std::fs::read(&registration).unwrap();
    let mut contender_command = command(&service.directory, &service.startup_error);
    fail_composition(&service.directory, &mut contender_command);
    contender_command.env("YCODING_DB", service.directory.0.join("contender.redb"));
    let mut contender = Runtime::spawn(contender_command, &["serve", "--service"]);
    assert_eq!(contender.wait().code(), Some(0));
    assert_eq!(contender.stdout(), Vec::<String>::new());
    assert_eq!(std::fs::read(&registration).unwrap(), original);
    service.assert_status(503);
    assert!(!service.startup_error.exists());

    let body = format!(r#"{{"instanceID":"{}"}}"#, string(&service.info, "id"));
    let (status, body, _) = request(
        &service.url,
        "/api/service/stop",
        Some(PASSWORD),
        Some(&body),
    );
    assert_eq!(status, 200);
    assert_eq!(
        field(&parse_json(&body).unwrap(), "accepted"),
        &JsonValue::Bool(true)
    );
    gate.child
        .stdin
        .take()
        .unwrap()
        .write_all(b"release\n")
        .unwrap();
    assert!(gate.wait().success());
    service.wait_and_diagnostics();
    assert!(!registration.exists());
    assert_port_released(&service.url).await;
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enabled_remote_waits_for_ready_and_failed_or_stopped_boot_never_opens_it() {
    use axum::{
        Router,
        extract::Path,
        http::StatusCode,
        routing::{get, post},
    };
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };
    use ycoding_core::remote::{Device, Enrollment};

    for outcome in ["ready", "failed", "stopped"] {
        let directory = Directory::new();
        let available = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = available.local_addr().unwrap().port();
        drop(available);
        configure_service(&directory, port);
        let local_url = format!("http://127.0.0.1:{port}");
        let calls = Arc::new(AtomicUsize::new(0));
        let early = Arc::new(AtomicBool::new(false));
        let socket = Arc::new(tokio::sync::Notify::new());
        let observed_calls = calls.clone();
        let observed_early = early.clone();
        let observed_url = local_url.clone();
        let auth = post(move |Path(operation): Path<String>| {
            let calls = observed_calls.clone();
            let early = observed_early.clone();
            let url = observed_url.clone();
            async move {
                if operation != "enroll" {
                    calls.fetch_add(1, Ordering::AcqRel);
                    if request(&url, "/api/health", Some(PASSWORD), None).0 != 200 {
                        early.store(true, Ordering::Release);
                    }
                }
                let expires = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64
                    + 600_000;
                let body = match operation.as_str() {
                    "enroll" => r#"{"deviceID":"device-readiness"}"#.to_owned(),
                    "challenge" => {
                        r#"{"challengeID":"challenge-readiness","nonce":"nonce-readiness"}"#
                            .to_owned()
                    }
                    "token" | "refresh" => format!(
                        r#"{{"accessToken":"synthetic-access","accessExpiresAt":{expires},"refreshToken":"synthetic-refresh","refreshExpiresAt":{expires}}}"#
                    ),
                    _ => panic!("unexpected authentication operation"),
                };
                (StatusCode::OK, body)
            }
        });
        let observed_socket = socket.clone();
        let observed_early = early.clone();
        let observed_url = local_url.clone();
        let router = Router::new().route("/api/devices/{operation}", auth).route(
            "/ws/v5/agent",
            get(move || {
                let socket = observed_socket.clone();
                let early = observed_early.clone();
                let url = observed_url.clone();
                async move {
                    if request(&url, "/api/health", Some(PASSWORD), None).0 != 200 {
                        early.store(true, Ordering::Release);
                    }
                    socket.notify_one();
                    StatusCode::SERVICE_UNAVAILABLE
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let relay_url = format!("http://{}", listener.local_addr().unwrap());
        let (stop_relay, stopped_relay) = tokio::sync::oneshot::channel::<()>();
        let relay = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped_relay.await;
                })
                .await
                .unwrap();
        });
        let state = directory
            .0
            .join("state")
            .join(ycoding_runtime::launch::namespace("local"));
        Device::new(&state)
            .unwrap()
            .enroll(
                Enrollment {
                    relay_origin: relay_url,
                    enrollment_id: "readiness-enrollment".into(),
                    code: "ABCD-EFGH-JKLM-NPQR-STUV".into(),
                    name: Some("Readiness fixture".into()),
                    replace: false,
                },
                1,
            )
            .await
            .unwrap();
        std::fs::write(state.join("remote.json"), r#"{"enabled":true}"#).unwrap();

        let fifo = directory.0.join("gated-models.json");
        assert!(
            Command::new("mkfifo")
                .arg(&fifo)
                .status()
                .unwrap()
                .success()
        );
        let mut gate = Runtime::spawn(
            Command::new("sh"),
            &[
                "-c",
                "exec 3>\"$1\"; printf 'catalog-reader-attached\\n'; IFS= read -r release; printf '{}' >&3; exec 3>&-",
                "catalog-gate",
                fifo.to_str().unwrap(),
            ],
        );
        let startup_error = directory.0.join("startup-error.txt");
        let mut owner = command(&directory, &startup_error);
        owner.env("YCODING_MODELS_PATH", &fifo);
        if outcome == "failed" {
            fail_composition(&directory, &mut owner);
        }
        let runtime = Runtime::spawn(owner, &["serve", "--service"]);
        assert_eq!(gate.ready(), "catalog-reader-attached");
        let mut service = FailedService::registered(runtime, directory, port, startup_error);
        service.assert_status(503);
        assert_eq!(calls.load(Ordering::Acquire), 0);
        let stop_body = format!(r#"{{"instanceID":"{}"}}"#, string(&service.info, "id"));
        if outcome == "stopped" {
            assert_eq!(
                request(
                    &service.url,
                    "/api/service/stop",
                    Some(PASSWORD),
                    Some(&stop_body)
                )
                .0,
                200
            );
        }
        gate.child
            .stdin
            .take()
            .unwrap()
            .write_all(b"release\n")
            .unwrap();
        assert!(gate.wait().success());
        match outcome {
            "ready" => {
                assert!(service.runtime.ready().starts_with("server listening on "));
                tokio::time::timeout(Duration::from_secs(30), socket.notified())
                    .await
                    .unwrap();
                assert!(calls.load(Ordering::Acquire) >= 2);
                assert!(!early.load(Ordering::Acquire));
                assert_eq!(
                    request(
                        &service.url,
                        "/api/service/stop",
                        Some(PASSWORD),
                        Some(&stop_body)
                    )
                    .0,
                    200
                );
            }
            "failed" => {
                service.wait_for_failed().await;
                assert_eq!(calls.load(Ordering::Acquire), 0);
                assert_eq!(
                    request(
                        &service.url,
                        "/api/service/stop",
                        Some(PASSWORD),
                        Some(&stop_body)
                    )
                    .0,
                    200
                );
            }
            "stopped" => {}
            _ => unreachable!(),
        }
        service.wait_and_diagnostics();
        if outcome != "ready" {
            assert_eq!(calls.load(Ordering::Acquire), 0);
        }
        stop_relay.send(()).unwrap();
        relay.await.unwrap();
        assert_port_released(&service.url).await;
    }
}
