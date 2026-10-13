#[path = "support/launcher.rs"]
mod launcher;
mod support;

use launcher::{Directory, Runtime, read, string};
use std::{
    io::{Read, Write},
    net::TcpStream,
    process::Command,
};
use ycoding_runtime::launch::{
    LaunchError, Parsed, default_service_port, parse_launch, service_filename, sha1_hex,
};

fn request(url: &str, path: &str, password: Option<&str>, body: Option<&str>) -> (u16, String) {
    let address = url.strip_prefix("http://").unwrap();
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(10)))
        .unwrap();
    let auth = password
        .map(|password| {
            format!(
                "Authorization: Basic {}\r\n",
                base64(format!("ycoding:{password}").as_bytes())
            )
        })
        .unwrap_or_default();
    let content = body.unwrap_or("");
    write!(stream, "{} {path} HTTP/1.1\r\nHost: {address}\r\n{auth}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{content}", if body.is_some() { "POST" } else { "GET" }, content.len()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    (
        response.split_whitespace().nth(1).unwrap().parse().unwrap(),
        response.split_once("\r\n\r\n").unwrap().1.into(),
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

fn service(directory: &Directory, channel: &str) -> (Runtime, String, String, String) {
    let runtime = Runtime::spawn(
        directory.command("test-v1", channel),
        &["serve", "--service", "--port", "0"],
    );
    let line = runtime.ready();
    let registration = read(&directory.registration(channel));
    let url = string(&registration, "url");
    assert_eq!(line, format!("server listening on {url}"));
    (
        runtime,
        url,
        string(&registration, "password"),
        string(&registration, "id"),
    )
}

#[test]
fn parses_modes_flags_paths_and_channel_hashes() {
    assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    assert_eq!(service_filename("latest"), "service.json");
    assert_eq!(service_filename("local"), "service-local.json");
    assert_eq!(
        service_filename("beta"),
        "service-a295e0bdde1938d1fbfd343e5a3e569e868e1465.json"
    );
    assert_eq!(default_service_port("beta"), 34393);
    for args in [
        vec!["--service", "--stdio"],
        vec!["--port", "70000"],
        vec!["--port", "-1"],
        vec!["--unknown"],
        vec!["--hostname"],
        vec!["--meeting=yes"],
    ] {
        let args = args.into_iter().map(str::to_string).collect::<Vec<_>>();
        assert!(matches!(
            parse_launch(&args, |key| (key == "HOME").then(|| "/synthetic".into())),
            Err(LaunchError::Usage(_))
        ));
        let directory = Directory::new();
        let output = directory
            .command("test-v1", "local")
            .args(&args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("Usage:"));
    }
    let Parsed::Run(config) = parse_launch(
        &["serve".into(), "--stdio".into(), "--port=0".into()],
        |key| match key {
            "HOME" => Some("/synthetic".into()),
            "YCODING_PASSWORD" => Some("secret".into()),
            _ => None,
        },
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(config.port, Some(0));
    assert_eq!(config.password, "secret");
    assert!(!config.meeting, "Meeting stays off unless requested");
    let Parsed::Run(meeting) = parse_launch(&["serve".into(), "--meeting".into()], |key| {
        (key == "HOME").then(|| "/synthetic".into())
    })
    .unwrap() else {
        panic!()
    };
    assert!(meeting.meeting);
}

#[test]
fn service_configuration_validation_and_cli_precedence_match_ts() {
    let directory = Directory::new();
    let config_dir = directory.0.join("config/ycoding");
    std::fs::create_dir_all(&config_dir).unwrap();
    let file = config_dir.join("service-local.json");
    let env = |key: &str| match key {
        "HOME" => Some(directory.0.join("home").to_string_lossy().into_owned()),
        "XDG_CONFIG_HOME" => Some(directory.0.join("config").to_string_lossy().into_owned()),
        _ => None,
    };
    std::fs::write(&file, "{\"port\":0,\"password\":\"invalid-config-secret\"}").unwrap();
    let Parsed::Run(invalid) = parse_launch(&["--service".into()], env).unwrap() else {
        panic!()
    };
    assert_eq!(invalid.port, Some(default_service_port("local")));
    assert!(invalid.password_generated);
    std::fs::write(
        &file,
        "{\"hostname\":\"localhost\",\"port\":12345,\"password\":\"configured-secret\"}",
    )
    .unwrap();
    let Parsed::Run(valid) = parse_launch(&["--service".into()], env).unwrap() else {
        panic!()
    };
    assert_eq!(valid.hostname, "localhost");
    assert_eq!(valid.port, Some(12345));
    assert_eq!(valid.password, "configured-secret");
    let Parsed::Run(overridden) = parse_launch(
        &[
            "--service".into(),
            "--hostname".into(),
            "127.0.0.1".into(),
            "--port=0".into(),
        ],
        env,
    )
    .unwrap() else {
        panic!()
    };
    assert_eq!(overridden.hostname, "127.0.0.1");
    assert_eq!(overridden.port, Some(0));
}

#[test]
fn stdio_readiness_authenticated_health_and_eof_shutdown() {
    let directory = Directory::new();
    let mut command = directory.command("test-v1", "local");
    command.env("YCODING_PASSWORD", "secret");
    let mut runtime = Runtime::spawn(command, &["--stdio", "--port", "0"]);
    let line = runtime.ready();
    let url = string(
        &ycoding_core::ycoding_schema::parse_json(&line).unwrap(),
        "url",
    );
    for path in ["/health", "/api/health"] {
        assert_eq!(request(&url, path, None, None).0, 401);
        assert_eq!(request(&url, path, Some("wrong"), None).0, 401);
        let (status, body) = request(&url, path, Some("secret"), None);
        assert_eq!(status, 200);
        assert!(body.contains("\"healthy\":true"));
        assert!(body.contains("\"version\":\"test-v1\""));
        assert!(body.contains(&format!("\"pid\":{}", runtime.child.id())));
    }
    assert_eq!(
        request(
            &url,
            "/api/service/stop",
            Some("secret"),
            Some("{\"instanceID\":\"wrong\"}")
        )
        .1,
        "{\"accepted\":false}"
    );
    drop(runtime.child.stdin.take());
    assert!(runtime.wait().success());
    assert!(TcpStream::connect(url.strip_prefix("http://").unwrap()).is_err());
    assert!(!directory.registration("local").exists());
}

#[test]
fn registration_is_private_atomic_and_password_is_persisted() {
    let directory = Directory::new();
    let (mut runtime, url, password, _) = service(&directory, "local");
    assert_eq!(request(&url, "/health", Some(&password), None).0, 200);
    let registration = directory.registration("local");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in [
            &registration,
            &directory.0.join("config/ycoding/service-local.json"),
        ] {
            assert_eq!(
                std::fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    assert_eq!(
        string(
            &read(&directory.0.join("config/ycoding/service-local.json")),
            "password"
        ),
        password
    );
    assert!(
        std::fs::read_dir(registration.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
    );
    let value = read(&registration);
    std::fs::write(&registration, format!("{{ \"password\":\"{password}\", \"pid\":{}, \"version\":\"test-v1\", \"url\":\"{url}\", \"id\":\"{}\" }}\n", runtime.child.id(), string(&value, "id"))).unwrap();
    runtime.signal("-TERM");
    assert!(runtime.wait().success());
    assert!(!registration.exists());
    let (mut next, _, next_password, _) = service(&directory, "local");
    assert_eq!(next_password, password);
    next.signal("-TERM");
    assert!(next.wait().success());
}

#[test]
fn simultaneous_contenders_elect_one_owner_even_on_ephemeral_ports() {
    let directory = Directory::new();
    let mut contenders = (0..6)
        .map(|_| {
            Runtime::spawn(
                directory.command("test-v1", "local"),
                &["--service", "--port", "0"],
            )
        })
        .collect::<Vec<_>>();
    let file = directory.registration("local");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let mut observed = 0;
    while !file.exists() {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    let value = read(&file);
    let url = string(&value, "url");
    let password = string(&value, "password");
    let text = std::fs::read_to_string(&file).unwrap();
    let mut winner = None;
    for (index, contender) in contenders.iter_mut().enumerate() {
        if text.contains(&format!("\"pid\":{}", contender.child.id())) {
            winner = Some(index);
            continue;
        }
        assert!(contender.wait().success());
        observed += 1;
        assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
    }
    assert_eq!(observed, 5);
    assert_eq!(request(&url, "/api/health", Some(&password), None).0, 200);
    contenders[winner.unwrap()].signal("-TERM");
    assert!(contenders[winner.unwrap()].wait().success());
    assert!(!file.exists());
}

#[test]
fn stop_auth_and_exact_instance_identity() {
    let directory = Directory::new();
    let (mut runtime, url, password, id) = service(&directory, "local");
    assert_eq!(request(&url, "/api/service/stop", None, Some("{}")).0, 401);
    assert_eq!(
        request(&url, "/api/service/stop", Some(&password), Some("{}")).0,
        400
    );
    assert_eq!(
        request(
            &url,
            "/api/service/stop",
            Some(&password),
            Some("{\"instanceID\":\"stale\"}")
        )
        .1,
        "{\"accepted\":false}"
    );
    assert_eq!(request(&url, "/health", Some(&password), None).0, 200);
    assert_eq!(
        request(
            &url,
            "/api/service/stop",
            Some(&password),
            Some(&format!("{{\"instanceID\":\"{id}\"}}"))
        )
        .1,
        "{\"accepted\":true}"
    );
    assert!(runtime.wait().success());
    assert!(!directory.registration("local").exists());
}

#[test]
fn signals_shutdown_and_foreign_registration_is_preserved() {
    for signal in ["-TERM", "-INT"] {
        let directory = Directory::new();
        let (mut runtime, _, _, _) = service(&directory, "local");
        std::fs::write(directory.registration("local"), "{\"foreign\":true}").unwrap();
        runtime.signal(signal);
        assert!(runtime.wait().success());
        assert_eq!(
            std::fs::read_to_string(directory.registration("local")).unwrap(),
            "{\"foreign\":true}"
        );
    }
}

#[test]
fn registration_loss_shuts_down_without_signals() {
    let directory = Directory::new();
    let (mut runtime, _, _, _) = service(&directory, "local");
    std::fs::remove_file(directory.registration("local")).unwrap();
    assert!(runtime.wait().success());
}

#[test]
fn beta_paths_are_resolved_without_adjacent_files() {
    let directory = Directory::new();
    let isolated = directory.0.join("extracted-runtime");
    std::fs::copy(env!("CARGO_BIN_EXE_ycoding-runtime"), &isolated).unwrap();
    let mut command = directory.command("test-v1", "beta");
    let env = command
        .get_envs()
        .map(|(key, value)| (key.to_owned(), value.map(ToOwned::to_owned)))
        .collect::<Vec<_>>();
    command = Command::new(&isolated);
    for (key, value) in &env {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    let output = command.arg("--paths").output().unwrap();
    assert!(output.status.success());
    let paths =
        ycoding_core::ycoding_schema::parse_json(std::str::from_utf8(&output.stdout).unwrap())
            .unwrap();
    assert_eq!(string(&paths, "namespace"), "ycoding-beta");
    for purpose in ["config", "state", "data", "cache"] {
        assert_eq!(
            string(&paths, purpose),
            directory
                .0
                .join(purpose)
                .join("ycoding-beta")
                .to_string_lossy()
        );
    }
    assert!(!directory.0.join("data/ycoding-beta").exists());
    let mut command = Command::new(&isolated);
    for (key, value) in env {
        if let Some(value) = value {
            command.env(key, value);
        } else {
            command.env_remove(key);
        }
    }
    let mut runtime = Runtime::spawn(command, &["--service", "--port", "0"]);
    assert!(
        runtime
            .ready()
            .starts_with("server listening on http://127.0.0.1:")
    );
    runtime.signal("-TERM");
    assert!(runtime.wait().success());
}

fn stable_fixture(directory: &Directory, wal: bool) -> std::process::Child {
    let file = directory.0.join("data/ycoding/ycoding.db");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let script = r#"
import sqlite3,sys,re
db=sqlite3.connect(sys.argv[1])
schema=open(sys.argv[2]).read()
for sql in re.findall(r'`((?:\\.|[^`])*)`',schema): db.executescript(sql.replace('\\`','`'))
db.executescript("CREATE TABLE migration(id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL);CREATE TABLE database_format(id TEXT PRIMARY KEY,time_created INTEGER NOT NULL);INSERT INTO database_format VALUES('current-2026-08-04',0);")
db.commit()
if sys.argv[3]=='wal': db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA wal_autocheckpoint=0')
db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES('prj_imported','/synthetic',1,2,'[]')")
db.commit()
print('ready',flush=True)
sys.stdin.read()
db.close()
"#;
    let mut child = Command::new("python3")
        .args(["-c", script])
        .arg(file)
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../packages/core/src/database/schema.gen.ts"
        ))
        .arg(if wal { "wal" } else { "plain" })
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::BufRead;
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "ready");
    child
}

#[test]
fn beta_import_copies_sqlite_and_wal_preserves_hashes_and_is_idempotent() {
    for wal in [false, true] {
        let directory = Directory::new();
        let mut source = stable_fixture(&directory, wal);
        let main = directory.0.join("data/ycoding/ycoding.db");
        let files = [
            main.clone(),
            main.with_file_name("ycoding.db-wal"),
            main.with_file_name("ycoding.db-shm"),
        ];
        let before = files
            .iter()
            .map(|file| std::fs::read(file).ok().map(|bytes| sha1_hex(&bytes)))
            .collect::<Vec<_>>();
        let (mut runtime, _, _, _) = service(&directory, "beta");
        let beta = directory.0.join("data/ycoding-beta/ycoding.redb");
        assert!(
            directory
                .0
                .join("state/ycoding-beta/stable-import-v1.json")
                .exists()
        );
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
        let store = ycoding_core::ycoding_store::Store::open(
            &beta,
            ycoding_core::ycoding_store::Options::core(),
            ycoding_core::ycoding_store::import::catalog(
                ycoding_core::ycoding_store::import::DatabaseKind::Core,
            ),
        )
        .unwrap();
        let snapshot = store.snapshot().unwrap();
        let rows = snapshot
            .scan::<ycoding_core::ycoding_store::project::ProjectTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10,
            )
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id.as_str(), Some("prj_imported"));
        assert!(
            snapshot
                .get::<ycoding_core::ycoding_store::import::ProvenanceTable>(&[])
                .unwrap()
                .is_some()
        );
        drop(snapshot);
        store.shutdown().unwrap();
        std::fs::remove_file(directory.0.join("state/ycoding-beta/stable-import-v1.json")).unwrap();
        let (mut second, _, _, _) = service(&directory, "beta");
        second.signal("-TERM");
        assert!(second.wait().success());
        assert!(
            directory
                .0
                .join("state/ycoding-beta/stable-import-v1.json")
                .exists()
        );
        assert_eq!(
            files
                .iter()
                .map(|file| std::fs::read(file).ok().map(|bytes| sha1_hex(&bytes)))
                .collect::<Vec<_>>(),
            before
        );
        drop(source.stdin.take());
        assert!(source.wait().unwrap().success());
    }
}

#[test]
fn invalid_stable_import_fails_without_marker_and_can_retry() {
    let directory = Directory::new();
    let file = directory.0.join("data/ycoding/ycoding.db");
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(&file, b"not SQLite").unwrap();
    let output = directory
        .command("test-v1", "beta")
        .args(["--service", "--port", "0"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(std::fs::read(&file).unwrap(), b"not SQLite");
    assert!(!directory.registration("beta").exists());
    assert!(
        !directory
            .0
            .join("state/ycoding-beta/stable-import-v1.json")
            .exists()
    );
    std::fs::remove_file(&file).unwrap();
    let (mut runtime, _, _, _) = service(&directory, "beta");
    runtime.signal("-TERM");
    assert!(runtime.wait().success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_binary_v5_health_and_stop_identity() {
    use prost::Message;
    use ycoding_protocol::v5;
    let directory = Directory::new();
    let (mut runtime, url, password, id) = service(&directory, "local");
    let address = url.strip_prefix("http://").unwrap().parse().unwrap();
    let auth = format!("Basic {}", base64(format!("ycoding:{password}").as_bytes()));
    let mut client = support::Client::open(address, &[("Authorization", auth)])
        .await
        .unwrap();
    let scope = v5::Scope {
        target: Some(v5::scope::Target::Machine(v5::Empty {})),
    };
    let health: v5::HealthGetResult = support::success(
        client
            .call(
                "health.get",
                scope.clone(),
                v5::HealthGetRequest {}.encode_to_vec(),
            )
            .await,
    );
    assert_eq!(support::units(&health.data.version), "test-v1");
    let wrong: v5::HealthStopResult = support::success(
        client
            .call(
                "health.stop",
                scope.clone(),
                v5::HealthStopRequest {
                    payload: v5::ServiceStopRequest {
                        instance_id: support::text("wrong"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(!wrong.data.accepted);
    let stopped: v5::HealthStopResult = support::success(
        client
            .call(
                "health.stop",
                scope,
                v5::HealthStopRequest {
                    payload: v5::ServiceStopRequest {
                        instance_id: support::text(&id),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(stopped.data.accepted);
    assert!(runtime.wait().success());
}

#[test]
fn beta_marker_rejects_invalid_completion_or_missing_imported_store() {
    for contents in [
        "not JSON",
        "{\"complete\":true,\"version\":1,\"imported\":true}\n",
    ] {
        let directory = Directory::new();
        let marker = directory.0.join("state/ycoding-beta/stable-import-v1.json");
        std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
        std::fs::write(&marker, contents).unwrap();
        let mut runtime = Runtime::spawn(
            directory.command("test-v1", "beta"),
            &["--service", "--port", "0"],
        );
        assert_eq!(runtime.wait().code(), Some(1));
        assert!(!directory.0.join("data/ycoding-beta/ycoding.redb").exists());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), contents);
    }
}

#[test]
fn beta_absent_source_decision_survives_retry_before_store_creation() {
    let directory = Directory::new();
    let marker = directory.0.join("state/ycoding-beta/stable-import-v1.json");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(
        marker,
        "{\"complete\":true,\"version\":1,\"imported\":false}\n",
    )
    .unwrap();
    let mut source = stable_fixture(&directory, false);
    let (mut runtime, _, _, _) = service(&directory, "beta");
    runtime.signal("-TERM");
    assert!(runtime.wait().success());
    let store = ycoding_core::ycoding_store::Store::open(
        directory.0.join("data/ycoding-beta/ycoding.redb"),
        ycoding_core::ycoding_store::Options::core(),
        ycoding_core::ycoding_store::import::catalog(
            ycoding_core::ycoding_store::import::DatabaseKind::Core,
        ),
    )
    .unwrap();
    let snapshot = store.snapshot().unwrap();
    assert!(
        snapshot
            .scan::<ycoding_core::ycoding_store::project::ProjectTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                10
            )
            .unwrap()
            .is_empty()
    );
    drop(snapshot);
    store.shutdown().unwrap();
    drop(source.stdin.take());
    assert!(source.wait().unwrap().success());
}

#[test]
fn unreadable_store_is_refused_with_a_sanitized_diagnostic_and_left_unchanged() {
    let directory = Directory::new();
    let data = directory.0.join("data/ycoding");
    std::fs::create_dir_all(&data).unwrap();
    let store = data.join("ycoding.redb");
    std::fs::write(&store, b"not a ycoding store").unwrap();
    let errors = directory.0.join("startup-error");
    let output = directory
        .command("test-v1", "local")
        .env("YCODING_SERVICE_STARTUP_ERROR_FILE", &errors)
        .args(["serve", "--service", "--port", "0"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let diagnostic = std::fs::read_to_string(&errors).unwrap();
    assert!(
        diagnostic.contains("unreadable or uses an unsupported format"),
        "{diagnostic}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("unreadable or uses an unsupported format"),
        "{stderr}"
    );
    for text in [&diagnostic, &stderr.to_string()] {
        assert!(!text.contains(store.to_str().unwrap()), "{text}");
    }
    assert_eq!(std::fs::read(&store).unwrap(), b"not a ycoding store");
    let stores = std::fs::read_dir(&data)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.starts_with("ycoding"))
        .collect::<Vec<_>>();
    assert_eq!(
        stores,
        ["ycoding.redb"],
        "no fresh or migrated store may appear"
    );
    assert!(!directory.registration("local").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn managed_service_shutdown_suspends_sessions_still_running() {
    use prost::Message;
    use ycoding_core::ycoding_store::{
        KeyPart, Metadata, Options, Store, import, project, session::SessionTable, tuple_key,
    };
    use ycoding_protocol::v5;
    let directory = Directory::new();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let (started, mut attempts) = tokio::sync::mpsc::unbounded_channel::<()>();
    tokio::spawn(async move {
        axum::serve(
            listener,
            axum::Router::new().route(
                "/chat/completions",
                axum::routing::post(move || {
                    let started = started.clone();
                    async move {
                        started.send(()).unwrap();
                        std::future::pending::<String>().await
                    }
                }),
            ),
        )
        .await
        .unwrap();
    });
    let config = directory.0.join("config/ycoding");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(
        config.join("ycoding.json"),
        format!(r#"{{"model":{{"providerID":"openai","model":"gpt-runtime"}},"providers":{{"openai":{{"settings":{{"baseURL":"{endpoint}"}}}}}}}}"#),
    )
    .unwrap();
    let catalog = directory.0.join("models.json");
    std::fs::write(&catalog, r#"{"openai":{"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"npm":"@ai-sdk/openai-compatible","models":{"gpt-runtime":{"id":"gpt-runtime","name":"Runtime","release_date":"2026-01-01","attachment":false,"reasoning":false,"tool_call":true,"limit":{"context":128000,"output":8192}}}}}"#).unwrap();
    let workspace = directory.0.join("project");
    std::fs::create_dir_all(&workspace).unwrap();
    let data = directory.0.join("data/ycoding");
    std::fs::create_dir_all(&data).unwrap();
    let file = data.join("ycoding.redb");
    let seeded = Store::initialize(
        &file,
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([9; 16], 1),
    )
    .unwrap();
    let placement = workspace.to_str().unwrap().to_owned();
    seeded
        .submit(move |tx| {
            project::ProjectTable::insert(
                tx,
                &project::Project {
                    id: "prj_one".into(),
                    worktree: placement.clone().into(),
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
            let mut row = support::record("ses_suspend");
            row.directory = placement.into();
            row.time_updated = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    seeded.shutdown().unwrap();
    let mut command = directory.command("test-v1", "local");
    command
        .env("OPENAI_API_KEY", "synthetic-key")
        .env("YCODING_MODELS_PATH", &catalog);
    let mut runtime = Runtime::spawn(command, &["serve", "--service", "--port", "0"]);
    runtime.ready();
    let registration = read(&directory.registration("local"));
    let url = string(&registration, "url");
    let password = string(&registration, "password");
    let address = url.strip_prefix("http://").unwrap().parse().unwrap();
    let auth = format!("Basic {}", base64(format!("ycoding:{password}").as_bytes()));
    let mut client = support::Client::open(address, &[("Authorization", auth)])
        .await
        .unwrap();
    let _: v5::SessionPromptResult = support::success(
        client
            .call(
                "session.prompt",
                support::session_scope("ses_suspend"),
                v5::SessionPromptRequest {
                    params: v5::SessionPromptRequestParams {
                        session_id: support::text("ses_suspend"),
                    },
                    payload: v5::SessionPromptRequestPayload {
                        id: Some(support::text("msg_suspend")),
                        text: support::text("Keep working"),
                        files: None,
                        agents: None,
                        metadata: None,
                        delivery: Some(v5::SessionPromptRequestPayloadDelivery::Steer as i32),
                        resume: Some(true),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    tokio::time::timeout(std::time::Duration::from_secs(30), attempts.recv())
        .await
        .unwrap()
        .unwrap();
    runtime.signal("-TERM");
    assert!(runtime.wait().success());
    let store = Store::open(
        &file,
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
    )
    .unwrap();
    let row = store
        .client()
        .snapshot()
        .unwrap()
        .get::<SessionTable>(&tuple_key(&[KeyPart::String(&"ses_suspend".into())]))
        .unwrap()
        .unwrap();
    assert!(
        row.time_suspended.is_some(),
        "a graceful managed-service stop must suspend Sessions still running"
    );
    store.shutdown().unwrap();
}
