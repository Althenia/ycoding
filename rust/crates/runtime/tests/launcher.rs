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

trait Isolated {
    fn isolated(&self, version: &str, channel: &str) -> Command;
}

impl Isolated for Directory {
    fn isolated(&self, version: &str, channel: &str) -> Command {
        let mut command = self.command(version, channel);
        for key in [
            "YCODING_DB",
            "YCODING_SQLITE_IMPORT_SOURCE",
            "YCODING_DISABLE_CHANNEL_DB",
        ] {
            command.env_remove(key);
        }
        command
    }
}

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
    start(directory, directory.isolated("test-v1", channel), channel)
}

fn start(
    directory: &Directory,
    command: Command,
    channel: &str,
) -> (Runtime, String, String, String) {
    let runtime = Runtime::spawn(command, &["serve", "--service", "--port", "0"]);
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
            .isolated("test-v1", "local")
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
fn startup_upgrades_recognized_native_catalogs_and_preserves_the_first_copy() {
    use ycoding_core::ycoding_store::{Catalog, Metadata, Options, Store, backup, import};

    for removed in [
        &["model_incident", "model_guidance_clear"][..],
        &[
            "model_incident",
            "model_guidance_clear",
            "usage_analytics_request",
        ][..],
    ] {
        let directory = Directory::new();
        let file = directory.0.join("predecessor.redb");
        let current = import::catalog(import::DatabaseKind::Core);
        let previous = Catalog::new(
            current.version,
            Box::leak(
                current
                    .tables()
                    .iter()
                    .copied()
                    .filter(|table| !removed.contains(&table.name))
                    .collect::<Vec<_>>()
                    .into_boxed_slice(),
            ),
        );
        Store::initialize(&file, Options::core(), previous, Metadata::new([17; 16], 1))
            .unwrap()
            .shutdown()
            .unwrap();
        let mut original_copy = None;
        for _ in 0..2 {
            let mut command = directory.isolated("test-v1", "beta");
            command.env("YCODING_DB", &file);
            let mut runtime = Runtime::spawn(command, &["--stdio", "--port", "0"]);
            runtime.ready();
            drop(runtime.child.stdin.take());
            assert!(runtime.wait().success());
            Store::open(&file, Options::core(), current)
                .unwrap()
                .shutdown()
                .unwrap();
            let copy = backup::upgrade_path(&file);
            let bytes = std::fs::read(&copy).unwrap();
            if let Some(original) = &original_copy {
                assert_eq!(&bytes, original);
            }
            // Store::open is writable, so inspect a disposable copy of the preserved backup.
            let inspection = directory.0.join("inspect-predecessor.redb");
            std::fs::copy(&copy, &inspection).unwrap();
            let inspected = Store::open(&inspection, Options::core(), previous).unwrap();
            assert_eq!(inspected.metadata(), &Metadata::new([17; 16], 1));
            inspected.shutdown().unwrap();
            assert_eq!(std::fs::read(&copy).unwrap(), bytes);
            original_copy = Some(bytes);
        }
    }
}

#[test]
fn startup_migrates_stored_approval_levels_once_across_restarts() {
    use ycoding_core::ycoding_schema::parse_json;
    use ycoding_core::ycoding_store::{
        KeyPart, Metadata, Options, Store, import, project, session::SessionTable, tuple_key,
    };
    let directory = Directory::new();
    let workspace = directory.0.join("project");
    std::fs::create_dir_all(&workspace).unwrap();
    let file = directory.0.join("autonomy.redb");
    let store = Store::initialize(
        &file,
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
        Metadata::new([13; 16], 1),
    )
    .unwrap();
    let placement = workspace.to_str().unwrap().to_owned();
    store
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
            let mut row = support::record("ses_startup_migration");
            row.directory = placement.into();
            row.autonomy = Some(
                parse_json(r#"{"mode":"normal","yolo":3,"autoAnswer":true,"extra":{"kept":1}}"#)
                    .unwrap(),
            );
            row.autonomy_revision = 5;
            row.time_updated = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            SessionTable::insert(tx, &row)
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
    for _ in 0..2 {
        let mut command = directory.isolated("test-v1", "beta");
        command.env("YCODING_DB", &file);
        let mut runtime = Runtime::spawn(command, &["--stdio", "--port", "0"]);
        runtime.ready();
        drop(runtime.child.stdin.take());
        assert!(runtime.wait().success());
        let store = Store::open(
            &file,
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
        )
        .unwrap();
        let row = store
            .snapshot()
            .unwrap()
            .get::<SessionTable>(&tuple_key(&[KeyPart::String(
                &"ses_startup_migration".into(),
            )]))
            .unwrap()
            .unwrap();
        assert_eq!(
            row.autonomy,
            Some(
                parse_json(r#"{"mode":"normal","yolo":2,"autoAnswer":true,"extra":{"kept":1}}"#)
                    .unwrap()
            )
        );
        assert_eq!(row.autonomy_revision, 6);
        store.shutdown().unwrap();
    }
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
    let mut command = directory.isolated("test-v1", "local");
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
                directory.isolated("test-v1", "local"),
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
    let mut command = directory.isolated("test-v1", "beta");
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
    source_fixture(
        &directory.0.join("data/ycoding/ycoding.db"),
        if wal { "wal" } else { "plain" },
        "prj_imported",
        "",
    )
}

fn source_fixture(
    file: &std::path::Path,
    mode: &str,
    project: &str,
    extra_sql: &str,
) -> std::process::Child {
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    let script = r#"
import sqlite3,sys,re
db=sqlite3.connect(sys.argv[1])
schema=open(sys.argv[2]).read()
for sql in re.findall(r'`((?:\\.|[^`])*)`',schema): db.executescript(sql.replace('\\`','`'))
db.executescript("CREATE TABLE migration(id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL);CREATE TABLE database_format(id TEXT PRIMARY KEY,time_created INTEGER NOT NULL);INSERT INTO database_format VALUES('current-2026-08-04',0);")
db.commit()
if sys.argv[3]!='rollback': db.execute('PRAGMA journal_mode=WAL')
if sys.argv[3]=='wal': db.execute('PRAGMA wal_autocheckpoint=0')
db.execute("INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES(?,'/synthetic',1,2,'[]')",(sys.argv[4],))
db.executescript(sys.argv[5])
db.commit()
if sys.argv[3]=='plain': db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
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
        .arg(mode)
        .arg(project)
        .arg(extra_sql)
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
        .isolated("test-v1", "beta")
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
            directory.isolated("test-v1", "beta"),
            &["--service", "--port", "0"],
        );
        assert_eq!(runtime.wait().code(), Some(1));
        assert!(!directory.0.join("data/ycoding-beta/ycoding.redb").exists());
        assert_eq!(std::fs::read_to_string(marker).unwrap(), contents);
    }
}

#[test]
fn beta_absent_source_decision_survives_restart_and_marker_loss() {
    let directory = Directory::new();
    let marker = directory.0.join("state/ycoding-beta/stable-import-v1.json");
    let (mut first, _, _, _) = service(&directory, "beta");
    first.signal("-TERM");
    assert!(first.wait().success());
    std::fs::remove_file(marker).unwrap();
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
        .isolated("test-v1", "local")
        .env("YCODING_DISABLE_CHANNEL_DB", "1")
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
    let mut command = directory.isolated("test-v1", "local");
    command
        .env("YCODING_DISABLE_CHANNEL_DB", "1")
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

#[test]
fn launch_resolution_validates_the_import_source_shape() {
    for (database, source) in [
        (Some("/synthetic/custom.redb"), Some("legacy.db")),
        (Some("/synthetic/custom.redb"), Some("./legacy.db")),
        (None, Some("/synthetic/legacy.db")),
        (Some(""), Some("/synthetic/legacy.db")),
        (Some(":memory:"), Some("/synthetic/legacy.db")),
    ] {
        let resolve = |arguments: &[String]| {
            parse_launch(arguments, |key| match key {
                "HOME" => Some("/synthetic".into()),
                "YCODING_DB" => database.map(String::from),
                "YCODING_SQLITE_IMPORT_SOURCE" => source.map(String::from),
                _ => None,
            })
        };
        let result = resolve(&["--service".into()]);
        assert!(
            matches!(&result, Err(LaunchError::Usage(message)) if message.contains("YCODING_SQLITE_IMPORT_SOURCE")),
            "{database:?} with {source:?} must be a usage error naming the variable"
        );
        assert!(
            matches!(resolve(&["--paths".into()]), Ok(Parsed::Paths(_))),
            "{database:?} with {source:?}: --paths ignores the store variables"
        );
    }
    for (database, source) in [
        (None, None),
        (Some(""), None),
        (Some(":memory:"), None),
        (Some("custom.redb"), None),
        (Some("/synthetic/custom.redb"), Some("/synthetic/legacy.db")),
        (Some("/synthetic/custom.redb"), Some("")),
    ] {
        let result = parse_launch(&["--service".into()], |key| match key {
            "HOME" => Some("/synthetic".into()),
            "YCODING_DB" => database.map(String::from),
            "YCODING_SQLITE_IMPORT_SOURCE" => source.map(String::from),
            _ => None,
        });
        assert!(
            !matches!(result, Err(LaunchError::Usage(_))),
            "{database:?} with {source:?} is a valid combination"
        );
    }
}

#[cfg(unix)]
mod store_path {
    use super::*;
    use std::{
        collections::BTreeMap,
        ops::Bound,
        os::unix::fs::{PermissionsExt, symlink},
        path::{Path, PathBuf},
        time::{Duration, Instant},
    };
    use ycoding_core::ycoding_store::{Metadata, Options, Store, import, project};
    use ycoding_protocol::v5;

    const SERVE: [&str; 3] = ["--service", "--port", "0"];

    fn utf8(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    fn mkdir(path: &Path, mode: u32) -> PathBuf {
        std::fs::create_dir_all(path).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
        path.to_path_buf()
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn digest(path: &Path) -> Option<String> {
        std::fs::read(path).ok().map(|bytes| sha1_hex(&bytes))
    }

    fn source_set(source: &Path) -> Vec<Option<String>> {
        ["", "-wal", "-journal", "-shm"]
            .into_iter()
            .map(|suffix| digest(Path::new(&format!("{}{suffix}", utf8(source)))))
            .collect()
    }

    fn tree(root: &Path) -> BTreeMap<String, String> {
        let mut entries = BTreeMap::new();
        walk(root, root, &mut entries);
        entries
    }

    fn walk(root: &Path, directory: &Path, entries: &mut BTreeMap<String, String>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            let info = std::fs::symlink_metadata(&path).unwrap();
            let name = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let mode = info.permissions().mode() & 0o7777;
            let value = if info.is_symlink() {
                format!("link {}", std::fs::read_link(&path).unwrap().display())
            } else if info.is_dir() {
                walk(root, &path, entries);
                format!("dir {mode:o}")
            } else {
                format!("file {mode:o} {}", sha1_hex(&std::fs::read(&path).unwrap()))
            };
            entries.insert(name, value);
        }
    }

    fn store_files(root: &Path) -> Vec<String> {
        tree(root)
            .into_keys()
            .filter(|name| {
                ["redb", "stable-import", ".lock", "pre-prune", "analytics"]
                    .iter()
                    .any(|pattern| name.contains(pattern))
            })
            .collect()
    }

    fn variables<'a>(
        database: Option<&'a str>,
        source: Option<&'a str>,
    ) -> Vec<(&'static str, &'a str)> {
        [
            ("YCODING_DB", database),
            ("YCODING_SQLITE_IMPORT_SOURCE", source),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
    }

    fn configured(directory: &Directory, channel: &str, environment: &[(&str, &str)]) -> Command {
        let mut command = directory.isolated("test-v1", channel);
        for (key, value) in environment {
            command.env(key, value);
        }
        command
    }

    fn serve(
        directory: &Directory,
        channel: &str,
        environment: &[(&str, &str)],
    ) -> (Runtime, String, String, String) {
        start(
            directory,
            configured(directory, channel, environment),
            channel,
        )
    }

    fn stop(mut runtime: Runtime) {
        runtime.signal("-TERM");
        assert!(runtime.wait().success());
    }

    fn finish(directory: &Directory, channel: &str, command: Command) -> (Option<i32>, String) {
        let mut runtime = Runtime::spawn(command, &SERVE);
        let deadline = Instant::now() + Duration::from_secs(20);
        let status = loop {
            if let Some(status) = runtime.child.try_wait().unwrap() {
                break status;
            }
            assert!(
                !directory.registration(channel).exists(),
                "the runtime started instead of refusing"
            );
            assert!(
                Instant::now() < deadline,
                "the runtime neither exited nor started"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        let mut stderr = String::new();
        runtime
            .child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        (status.code(), stderr)
    }

    fn refused(directory: &Directory, channel: &str, environment: &[(&str, &str)]) -> String {
        let command = configured(directory, channel, environment);
        let before = tree(&directory.0);
        let (code, stderr) = finish(directory, channel, command);
        assert_eq!(code, Some(1), "{stderr}");
        assert_eq!(
            tree(&directory.0),
            before,
            "a refusal must leave every file, directory and mode unchanged"
        );
        stderr
    }

    fn open(file: &Path) -> Store {
        Store::open(
            file,
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
        )
        .unwrap()
    }

    fn projects(file: &Path) -> Vec<String> {
        let store = open(file);
        let snapshot = store.snapshot().unwrap();
        let ids = snapshot
            .scan::<project::ProjectTable>(Bound::Unbounded, Bound::Unbounded, 100)
            .unwrap()
            .iter()
            .map(|row| row.id.as_str().unwrap().to_owned())
            .collect();
        drop(snapshot);
        store.shutdown().unwrap();
        ids
    }

    fn provenance(file: &Path) -> bool {
        let store = open(file);
        let snapshot = store.snapshot().unwrap();
        let found = snapshot
            .get::<import::ProvenanceTable>(&[])
            .unwrap()
            .is_some();
        drop(snapshot);
        store.shutdown().unwrap();
        found
    }

    fn add_project(store: &Store, id: &str) {
        let id = id.to_owned();
        store
            .submit(move |tx| {
                project::ProjectTable::insert(
                    tx,
                    &project::Project {
                        id: id.clone().into(),
                        worktree: "/synthetic".into(),
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
                )
            })
            .unwrap()
            .wait()
            .unwrap();
    }

    fn native(file: &Path, id: &str) {
        let store = Store::initialize(
            file,
            Options::core(),
            import::catalog(import::DatabaseKind::Core),
            Metadata::new([9; 16], 1),
        )
        .unwrap();
        add_project(&store, id);
        store.shutdown().unwrap();
    }

    fn write_project(file: &Path, id: &str) {
        let store = open(file);
        add_project(&store, id);
        store.shutdown().unwrap();
    }

    fn closed(file: &Path, mode: &str, project: &str, sql: &str) {
        let mut child = source_fixture(file, mode, project, sql);
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
    }

    fn release(mut source: std::process::Child) {
        drop(source.stdin.take());
        assert!(source.wait().unwrap().success());
    }

    fn staging(directory: &Path) -> Vec<String> {
        std::fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with(".stable-import-"))
            .collect()
    }

    async fn client(url: &str, password: &str) -> support::Client {
        let address = url.strip_prefix("http://").unwrap().parse().unwrap();
        let auth = format!("Basic {}", base64(format!("ycoding:{password}").as_bytes()));
        support::Client::open(address, &[("Authorization", auth)])
            .await
            .unwrap()
    }

    async fn create_session(url: &str, password: &str, directory: &Path) -> String {
        let mut client = client(url, password).await;
        let created: v5::SessionCreateResult = support::wire::ask(
            &mut client,
            "session.create",
            support::wire::location_scope(utf8(directory)),
            v5::SessionCreateRequest {
                payload: v5::SessionCreateRequestPayload {
                    id: None,
                    parent_id: None,
                    agent: None,
                    model: None,
                    location: Some(v5::LocationRef {
                        directory: support::text(utf8(directory)),
                        workspace_id: None,
                    }),
                },
            },
        )
        .await;
        support::units(&created.data.id)
    }

    async fn session_is_unknown(url: &str, password: &str, id: &str) {
        let mut client = client(url, password).await;
        let missing: v5::SessionNotFoundError = support::wire::refuse(
            &mut client,
            "session.get",
            support::session_scope(id),
            v5::SessionGetRequest {
                params: v5::SessionGetRequestParams {
                    session_id: support::text(id),
                },
            },
        )
        .await;
        assert_eq!(support::units(&missing.session_id), id);
    }

    #[test]
    fn import_source_shape_is_a_usage_error_before_any_side_effect() {
        for scenario in 0..5 {
            let directory = Directory::new();
            let targets = mkdir(&directory.0.join("targets"), 0o755);
            let target = targets.join("custom.redb");
            let source = directory.0.join("sources/legacy.db");
            closed(&source, "plain", "prj_usage_sentinel", "");
            let (database, value) = match scenario {
                0 => (Some(utf8(&target)), "relative/legacy.db"),
                1 => (None, utf8(&source)),
                2 => (Some(""), utf8(&source)),
                3 => (Some(":memory:"), utf8(&source)),
                _ => (Some(utf8(&target)), "./legacy.db"),
            };
            let environment = variables(database, Some(value));
            let mut paths_command = configured(&directory, "local", &environment);
            let before = tree(&directory.0);
            let paths = paths_command.arg("--paths").output().unwrap();
            assert!(
                paths.status.success(),
                "scenario {scenario}: --paths ignores the store variables"
            );
            assert!(!paths.stdout.is_empty(), "scenario {scenario}");
            assert_eq!(
                tree(&directory.0),
                before,
                "scenario {scenario}: --paths has no side effects"
            );
            let command = configured(&directory, "local", &environment);
            let (code, stderr) = finish(&directory, "local", command);
            assert_eq!(code, Some(2), "scenario {scenario}: {stderr}");
            assert!(
                stderr.contains("YCODING_SQLITE_IMPORT_SOURCE"),
                "scenario {scenario}: {stderr}"
            );
            assert!(!stderr.contains("prj_usage_sentinel"), "{stderr}");
            assert_eq!(tree(&directory.0), before, "scenario {scenario}");
        }
    }

    #[test]
    fn paths_output_ignores_the_store_variables() {
        for channel in ["beta", "dev"] {
            let directory = Directory::new();
            let targets = mkdir(&directory.0.join("targets"), 0o755);
            let target = targets.join("custom.redb");
            let source = directory.0.join("sources/legacy.db");
            closed(&source, "plain", "prj_paths", "");
            let plain = configured(&directory, channel, &[])
                .arg("--paths")
                .output()
                .unwrap();
            let selected = configured(
                &directory,
                channel,
                &[
                    ("YCODING_DB", utf8(&target)),
                    ("YCODING_SQLITE_IMPORT_SOURCE", utf8(&source)),
                    ("YCODING_DISABLE_CHANNEL_DB", "1"),
                ],
            )
            .arg("--paths")
            .output()
            .unwrap();
            assert!(plain.status.success(), "{channel}");
            assert!(selected.status.success(), "{channel}");
            assert_eq!(plain.stdout, selected.stdout, "{channel}");
        }
    }

    fn location_case(directory: &Directory, case: &str) -> PathBuf {
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        match case {
            "absent-parent" => targets.join("missing/custom.redb"),
            "parent-file" => {
                std::fs::write(targets.join("file"), b"synthetic").unwrap();
                targets.join("file/custom.redb")
            }
            "parent-symlink" => {
                let real = mkdir(&targets.join("real"), 0o755);
                symlink(&real, targets.join("link")).unwrap();
                targets.join("link/custom.redb")
            }
            "directory" => mkdir(&targets.join("custom.redb"), 0o755),
            "symlink" => {
                native(&targets.join("other.redb"), "prj_other");
                symlink(targets.join("other.redb"), targets.join("custom.redb")).unwrap();
                targets.join("custom.redb")
            }
            _ => panic!("unknown case {case}"),
        }
    }

    #[test]
    fn unusable_explicit_targets_are_refused_before_side_effects() {
        for case in [
            "absent-parent",
            "parent-file",
            "parent-symlink",
            "directory",
            "symlink",
        ] {
            for with_source in [false, true] {
                let directory = Directory::new();
                let target = location_case(&directory, case);
                let source = directory.0.join("sources/legacy.db");
                if with_source {
                    closed(&source, "plain", "prj_legacy", "");
                }
                let environment =
                    variables(Some(utf8(&target)), with_source.then(|| utf8(&source)));
                refused(&directory, "local", &environment);
                assert_eq!(mode(&directory.0.join("targets")), 0o755, "{case}");
            }
        }
    }

    #[test]
    fn sqlite_target_is_refused_with_a_dedicated_diagnostic_and_left_unchanged() {
        let directory = Directory::new();
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("custom.redb");
        closed(&target, "plain", "prj_target_sentinel", "");
        let source = directory.0.join("sources/legacy.db");
        closed(&source, "plain", "prj_legacy", "");
        for with_source in [false, true] {
            let environment = variables(Some(utf8(&target)), with_source.then(|| utf8(&source)));
            let stderr = refused(&directory, "local", &environment).to_lowercase();
            assert!(stderr.contains("sqlite"), "{stderr}");
            assert!(!stderr.contains("prj_target_sentinel"), "{stderr}");
        }
    }

    fn precondition_case(directory: &Directory, case: &str) -> (PathBuf, PathBuf) {
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("custom.redb");
        let sources = directory.0.join("sources");
        let source = sources.join("legacy.db");
        match case {
            "source-absent" => (),
            "source-directory" => {
                mkdir(&source, 0o755);
            }
            "source-symlink" => {
                closed(&sources.join("real.db"), "plain", "prj_legacy", "");
                symlink(sources.join("real.db"), &source).unwrap();
            }
            "unmarked-target" => {
                native(&target, "prj_existing");
                closed(&source, "plain", "prj_legacy", "");
            }
            _ => panic!("unknown case {case}"),
        }
        (target, source)
    }

    #[test]
    fn import_preconditions_refuse_before_side_effects() {
        for case in [
            "source-absent",
            "source-directory",
            "source-symlink",
            "unmarked-target",
        ] {
            let directory = Directory::new();
            let (target, source) = precondition_case(&directory, case);
            let environment = variables(Some(utf8(&target)), Some(utf8(&source)));
            refused(&directory, "local", &environment);
            assert_eq!(mode(&directory.0.join("targets")), 0o755, "{case}");
        }
    }

    fn alias_case(directory: &Directory, case: &str) -> (PathBuf, PathBuf) {
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("custom.redb");
        match case {
            "same" => {
                let file = targets.join("legacy.db");
                closed(&file, "plain", "prj_legacy", "");
                (file.clone(), file)
            }
            "staging" => {
                let source = targets.join(".stable-import-synthetic.redb");
                closed(&source, "plain", "prj_legacy", "");
                (target, source)
            }
            "hardlink" => {
                let source = mkdir(&directory.0.join("sources"), 0o755).join("legacy.db");
                closed(&source, "plain", "prj_legacy", "");
                std::fs::hard_link(&source, &target).unwrap();
                (target, source)
            }
            "parent-symlink" => {
                let real = mkdir(&directory.0.join("real"), 0o755);
                closed(&real.join("legacy.db"), "plain", "prj_legacy", "");
                symlink(&real, directory.0.join("alias")).unwrap();
                (real.join("legacy.db"), directory.0.join("alias/legacy.db"))
            }
            _ => {
                if let Some(suffix) = case.strip_prefix("companion") {
                    let source = PathBuf::from(format!("{}{suffix}", utf8(&target)));
                    closed(&source, "plain", "prj_legacy", "");
                    return (target, source);
                }
                let suffix = case.strip_prefix("sidecar").expect(case);
                let source = targets.join("legacy.db");
                closed(&source, "plain", "prj_legacy", "");
                (PathBuf::from(format!("{}{suffix}", utf8(&source))), source)
            }
        }
    }

    #[test]
    fn source_aliases_are_refused_before_side_effects() {
        for case in [
            "same",
            "staging",
            "hardlink",
            "parent-symlink",
            "companion.runtime.lock",
            "companion.analytics",
            "companion.pre-prune-backup",
            "companion.pre-prune-backup.complete",
            "companion.stable-import-v1.json",
            "companion.stable-import-v1.stage-v2",
            "companion.stable-import-v1.import-lock",
            "sidecar-wal",
            "sidecar-journal",
            "sidecar-shm",
        ] {
            let directory = Directory::new();
            let (target, source) = alias_case(&directory, case);
            let sources = source_set(&source);
            let environment = variables(Some(utf8(&target)), Some(utf8(&source)));
            refused(&directory, "local", &environment);
            assert_eq!(source_set(&source), sources, "{case}");
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn memory_store_keeps_no_files_and_forgets_data_after_restart() {
        for (channel, data, state, tmp) in [
            ("local", "data/ycoding", "state/ycoding", "tmp/ycoding"),
            (
                "beta",
                "data/ycoding-beta",
                "state/ycoding-beta",
                "tmp/ycoding-beta",
            ),
        ] {
            let directory = Directory::new();
            let stable = directory.0.join("data/ycoding/ycoding.db");
            closed(&stable, "plain", "prj_stable", "");
            let hash = digest(&stable);
            let workspace = mkdir(&directory.0.join("project"), 0o755);
            let environment = [("YCODING_DB", ":memory:")];

            let (runtime, url, password, _) = serve(&directory, channel, &environment);
            let id = create_session(&url, &password, &workspace).await;
            assert_eq!(
                store_files(&directory.0.join(data)),
                Vec::<String>::new(),
                "{channel}: no store, lease, analytics, marker, journal or backup file"
            );
            assert_eq!(store_files(&directory.0.join(state)), Vec::<String>::new());
            stop(runtime);
            assert_eq!(store_files(&directory.0.join(data)), Vec::<String>::new());
            assert_eq!(store_files(&directory.0.join(state)), Vec::<String>::new());
            assert!(
                tree(&directory.0.join("tmp"))
                    .keys()
                    .all(|name| !name.contains('/')),
                "{channel}: the private analytics directory under {tmp} is removed after stop"
            );
            assert_eq!(
                digest(&stable),
                hash,
                "{channel}: the stable SQLite stays untouched"
            );

            let (runtime, url, password, _) = serve(&directory, channel, &environment);
            session_is_unknown(&url, &password, &id).await;
            stop(runtime);
            assert_eq!(store_files(&directory.0.join(data)), Vec::<String>::new());
            assert_eq!(digest(&stable), hash);
        }
    }

    #[test]
    fn absolute_target_hosts_the_store_with_companions_beside_it() {
        for channel in ["local", "beta"] {
            let directory = Directory::new();
            let stable = directory.0.join("data/ycoding/ycoding.db");
            closed(&stable, "plain", "prj_stable", "");
            let stable_hash = digest(&stable);
            let (slot, slot_name) = if channel == "beta" {
                (
                    directory.0.join("data/ycoding-beta/ycoding.redb"),
                    "ycoding-beta/ycoding.redb",
                )
            } else {
                (
                    directory.0.join("data/ycoding/ycoding-local.redb"),
                    "ycoding/ycoding-local.redb",
                )
            };
            mkdir(slot.parent().unwrap(), 0o700);
            native(&slot, "prj_slot");
            let targets = mkdir(&directory.0.join("targets"), 0o755);
            let target = targets.join("custom.redb");
            let environment = [("YCODING_DB", utf8(&target))];

            let (runtime, ..) = serve(&directory, channel, &environment);
            assert!(target.is_file(), "{channel}");
            assert!(
                targets.join("custom.redb.runtime.lock").is_file(),
                "{channel}: the lease sits beside the target"
            );
            stop(runtime);
            assert_eq!(projects(&target), Vec::<String>::new(), "{channel}");
            assert_eq!(
                store_files(&directory.0.join("data")),
                vec![slot_name.to_string()],
                "{channel}: no slot companion appears"
            );
            assert_eq!(
                store_files(&directory.0.join("state")),
                Vec::<String>::new()
            );
            assert_eq!(projects(&slot), ["prj_slot"], "{channel}");
            assert_eq!(digest(&stable), stable_hash, "{channel}");
            assert_eq!(mode(&targets), 0o755, "{channel}");

            write_project(&target, "prj_kept");
            let (runtime, ..) = serve(&directory, channel, &environment);
            stop(runtime);
            assert_eq!(projects(&target), ["prj_kept"], "{channel}");
            assert!(!targets.join("custom.redb.stable-import-v1.json").exists());
        }
    }

    #[test]
    fn existing_native_target_is_opened_and_never_imported_without_a_source() {
        let directory = Directory::new();
        let stable = directory.0.join("data/ycoding/ycoding.db");
        closed(&stable, "plain", "prj_stable", "");
        let stable_hash = digest(&stable);
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("custom.redb");
        native(&target, "prj_existing");
        let (runtime, ..) = serve(&directory, "local", &[("YCODING_DB", utf8(&target))]);
        stop(runtime);
        assert_eq!(projects(&target), ["prj_existing"]);
        assert!(!targets.join("custom.redb.stable-import-v1.json").exists());
        assert_eq!(digest(&stable), stable_hash);
    }

    #[test]
    fn distinct_targets_run_side_by_side_and_one_target_has_one_lease() {
        let directory = Directory::new();
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let first = targets.join("first.redb");
        let second = targets.join("second.redb");
        let (one, ..) = serve(&directory, "local", &[("YCODING_DB", utf8(&first))]);
        let (two, ..) = serve(&directory, "dev", &[("YCODING_DB", utf8(&second))]);
        let (three, ..) = serve(&directory, "slot", &[]);
        assert!(first.is_file() && second.is_file());
        assert!(directory.0.join("data/ycoding/ycoding-slot.redb").is_file());
        assert!(directory.0.join("data/ycoding/runtime-slot.lock").is_file());
        assert!(!directory.0.join("data/ycoding/runtime.lock").exists());
        let mut contender = Runtime::spawn(
            configured(&directory, "contend", &[("YCODING_DB", utf8(&first))]),
            &SERVE,
        );
        assert!(
            contender.wait().success(),
            "the second runtime on one target yields"
        );
        assert!(!directory.registration("contend").exists());
        stop(three);
        stop(two);
        stop(one);
    }

    #[test]
    fn direct_child_targets_of_a_fresh_roots_data_are_accepted() {
        for (channel, data) in [
            ("latest", "data/ycoding"),
            ("local", "data/ycoding"),
            ("beta", "data/ycoding-beta"),
        ] {
            for absolute in [false, true] {
                let directory = Directory::new();
                if channel == "beta" {
                    closed(
                        &directory.0.join("data/ycoding/ycoding.db"),
                        "plain",
                        "prj_stable",
                        "",
                    );
                }
                let root = directory.0.join(data);
                let target = root.join("custom.redb");
                let value = if absolute {
                    utf8(&target)
                } else {
                    "custom.redb"
                };
                let (runtime, ..) = serve(&directory, channel, &[("YCODING_DB", value)]);
                stop(runtime);
                let label = format!("{channel} absolute={absolute}");
                assert!(target.is_file(), "{label}");
                assert!(root.join("custom.redb.runtime.lock").is_file(), "{label}");
                assert!(!root.join("ycoding.redb").exists(), "{label}");
                assert!(!root.join("ycoding-local.redb").exists(), "{label}");
                assert!(!root.join("runtime.lock").exists(), "{label}");
                assert!(!root.join("runtime-local.lock").exists(), "{label}");
                assert!(!root.join("analytics").exists(), "{label}");
                assert_eq!(projects(&target), Vec::<String>::new(), "{label}");
                assert_eq!(
                    store_files(&directory.0.join("state")),
                    Vec::<String>::new(),
                    "{label}"
                );
            }
        }
    }

    #[test]
    fn other_missing_target_parents_are_refused_before_side_effects() {
        for (channel, data) in [("latest", "data/ycoding"), ("beta", "data/ycoding-beta")] {
            for case in [
                "sub/x.redb",
                "../x.redb",
                "sub/../x.redb",
                "ABSOLUTE-NESTED",
                "ABSOLUTE-DOTDOT",
                "ABSOLUTE-ELSEWHERE",
            ] {
                let directory = Directory::new();
                let nested = directory.0.join(data).join("sub/x.redb");
                let dotdot = directory.0.join(data).join("sub/../x.redb");
                let elsewhere = directory.0.join("elsewhere/x.redb");
                let value = match case {
                    "ABSOLUTE-NESTED" => utf8(&nested),
                    "ABSOLUTE-DOTDOT" => utf8(&dotdot),
                    "ABSOLUTE-ELSEWHERE" => utf8(&elsewhere),
                    relative => relative,
                };
                refused(&directory, channel, &[("YCODING_DB", value)]);
                assert!(!directory.0.join("data").exists(), "{channel} {case}");
                assert!(!directory.0.join("elsewhere").exists(), "{channel} {case}");
            }
        }
    }

    #[test]
    fn target_equal_to_the_slot_path_behaves_exactly_like_unset() {
        for aliased in [false, true] {
            let directory = Directory::new();
            let real = directory.0.join(if aliased { "realdata" } else { "data" });
            if aliased {
                mkdir(&real, 0o755);
                symlink(&real, directory.0.join("data")).unwrap();
            }
            closed(
                &directory.0.join("data/ycoding/ycoding.db"),
                "plain",
                "prj_imported",
                "",
            );
            let target = real.join("ycoding-beta/ycoding.redb");
            let (runtime, ..) = serve(&directory, "beta", &[("YCODING_DB", utf8(&target))]);
            stop(runtime);
            let slot = directory.0.join("data/ycoding-beta");
            assert_eq!(
                projects(&slot.join("ycoding.redb")),
                ["prj_imported"],
                "{aliased}"
            );
            assert!(provenance(&slot.join("ycoding.redb")));
            assert!(
                directory
                    .0
                    .join("state/ycoding-beta/stable-import-v1.json")
                    .is_file(),
                "{aliased}: the slot marker seals the default import"
            );
            assert!(slot.join("runtime.lock").is_file(), "{aliased}");
            assert!(
                !slot.join("ycoding.redb.runtime.lock").exists(),
                "{aliased}"
            );
            assert!(!slot.join("ycoding.redb.stable-import-v1.json").exists());
        }
    }

    #[test]
    fn slot_path_identity_holds_for_stable_channels() {
        for channel in ["latest", "prod"] {
            let directory = Directory::new();
            closed(
                &directory.0.join("data/ycoding/ycoding.db"),
                "plain",
                "prj_stable",
                "",
            );
            let target = directory.0.join("data/ycoding/ycoding.redb");
            let (runtime, ..) = serve(&directory, channel, &[("YCODING_DB", utf8(&target))]);
            stop(runtime);
            let root = directory.0.join("data/ycoding");
            assert!(target.is_file(), "{channel}");
            assert!(root.join("runtime.lock").is_file(), "{channel}");
            assert!(
                !root.join("ycoding.redb.runtime.lock").exists(),
                "{channel}"
            );
            assert!(!root.join(format!("ycoding-{channel}.redb")).exists());
            assert_eq!(projects(&target), Vec::<String>::new(), "{channel}");
            assert!(
                !directory
                    .0
                    .join("state/ycoding/stable-import-v1.json")
                    .exists(),
                "{channel}: the stable slot never imports without an explicit source"
            );
        }
    }

    #[test]
    fn stable_slot_never_imports_automatically_and_opens_an_existing_store() {
        for channel in ["latest", "prod"] {
            let directory = Directory::new();
            let stable = directory.0.join("data/ycoding/ycoding.db");
            closed(&stable, "plain", "prj_stable", "");
            let hash = source_set(&stable);
            let (runtime, ..) = serve(&directory, channel, &[]);
            stop(runtime);
            let root = directory.0.join("data/ycoding");
            assert_eq!(
                projects(&root.join("ycoding.redb")),
                Vec::<String>::new(),
                "{channel}"
            );
            assert!(root.join("runtime.lock").is_file(), "{channel}");
            assert_eq!(
                store_files(&directory.0.join("state")),
                Vec::<String>::new(),
                "{channel}: no marker"
            );
            assert_eq!(source_set(&stable), hash, "{channel}");
        }
        let directory = Directory::new();
        let stable = directory.0.join("data/ycoding/ycoding.db");
        closed(&stable, "plain", "prj_stable", "");
        let store = directory.0.join("data/ycoding/ycoding.redb");
        native(&store, "prj_stage");
        let (runtime, ..) = serve(&directory, "latest", &[]);
        stop(runtime);
        assert_eq!(projects(&store), ["prj_stage"]);
        assert_eq!(
            store_files(&directory.0.join("state")),
            Vec::<String>::new()
        );
    }

    #[test]
    fn exact_selector_values_select_the_stable_slot_on_other_channels() {
        for value in ["1", "true"] {
            let directory = Directory::new();
            let channel_source = directory.0.join("data/ycoding/ycoding-dev.db");
            closed(&channel_source, "plain", "prj_dev", "");
            let stable = directory.0.join("data/ycoding/ycoding.db");
            closed(&stable, "plain", "prj_stable", "");
            let hash = (digest(&channel_source), digest(&stable));
            let (runtime, ..) = serve(&directory, "dev", &[("YCODING_DISABLE_CHANNEL_DB", value)]);
            stop(runtime);
            let root = directory.0.join("data/ycoding");
            assert!(!root.join("runtime-dev.lock").exists(), "{value}");
            assert!(!root.join("analytics-dev").exists(), "{value}");
            assert!(
                !directory
                    .0
                    .join("state/ycoding/stable-import-v1.json")
                    .exists(),
                "{value}: the stable slot never imports automatically"
            );
            assert_eq!(
                projects(&root.join("ycoding.redb")),
                Vec::<String>::new(),
                "{value}"
            );
            assert!(root.join("runtime.lock").is_file(), "{value}");
            assert!(!root.join("ycoding-dev.redb").exists(), "{value}");
            assert!(
                !directory
                    .0
                    .join("state/ycoding/stable-import-dev-v1.json")
                    .exists(),
                "{value}"
            );
            assert_eq!((digest(&channel_source), digest(&stable)), hash, "{value}");
        }
    }

    #[test]
    fn other_selector_values_keep_the_channel_slot() {
        for value in ["TRUE", "yes", "0", ""] {
            let directory = Directory::new();
            closed(
                &directory.0.join("data/ycoding/ycoding-dev.db"),
                "plain",
                "prj_dev",
                "",
            );
            let (runtime, ..) = serve(&directory, "dev", &[("YCODING_DISABLE_CHANNEL_DB", value)]);
            stop(runtime);
            let root = directory.0.join("data/ycoding");
            assert_eq!(
                projects(&root.join("ycoding-dev.redb")),
                ["prj_dev"],
                "{value:?}"
            );
            assert!(!root.join("ycoding.redb").exists(), "{value:?}");
            assert!(
                directory
                    .0
                    .join("state/ycoding/stable-import-dev-v1.json")
                    .is_file(),
                "{value:?}"
            );
        }
    }

    #[test]
    fn selector_does_not_change_beta_latest_or_prod() {
        let directory = Directory::new();
        closed(
            &directory.0.join("data/ycoding/ycoding.db"),
            "plain",
            "prj_stable",
            "",
        );
        let (runtime, ..) = serve(&directory, "beta", &[("YCODING_DISABLE_CHANNEL_DB", "1")]);
        stop(runtime);
        assert_eq!(
            projects(&directory.0.join("data/ycoding-beta/ycoding.redb")),
            ["prj_stable"]
        );
        for channel in ["latest", "prod"] {
            let directory = Directory::new();
            let (runtime, ..) = serve(&directory, channel, &[("YCODING_DISABLE_CHANNEL_DB", "1")]);
            stop(runtime);
            let root = directory.0.join("data/ycoding");
            assert!(root.join("ycoding.redb").is_file(), "{channel}");
            assert!(!root.join(format!("ycoding-{channel}.redb")).exists());
        }
    }

    #[test]
    fn explicit_database_wins_over_the_selector_and_empty_values_are_unset() {
        let directory = Directory::new();
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("custom.redb");
        let (runtime, ..) = serve(
            &directory,
            "dev",
            &[
                ("YCODING_DB", utf8(&target)),
                ("YCODING_DISABLE_CHANNEL_DB", "1"),
            ],
        );
        stop(runtime);
        let root = directory.0.join("data/ycoding");
        assert!(target.is_file());
        assert!(!root.join("ycoding.redb").exists());
        assert!(!root.join("ycoding-dev.redb").exists());

        let directory = Directory::new();
        let (runtime, ..) = serve(&directory, "dev", &[("YCODING_DB", "")]);
        stop(runtime);
        let root = directory.0.join("data/ycoding");
        assert!(root.join("ycoding-dev.redb").is_file());
        assert!(!root.join("ycoding.redb").exists());

        let directory = Directory::new();
        let (runtime, ..) = serve(
            &directory,
            "dev",
            &[("YCODING_DB", ""), ("YCODING_DISABLE_CHANNEL_DB", "true")],
        );
        stop(runtime);
        let root = directory.0.join("data/ycoding");
        assert!(root.join("ycoding.redb").is_file());
        assert!(!root.join("ycoding-dev.redb").exists());
    }

    #[test]
    fn other_channel_imports_its_own_sqlite_once_and_preserves_the_source() {
        for wal in [false, true] {
            let directory = Directory::new();
            let source = directory.0.join("data/ycoding/ycoding-dev.db");
            let held = source_fixture(&source, if wal { "wal" } else { "plain" }, "prj_dev", "");
            let stable = directory.0.join("data/ycoding/ycoding.db");
            closed(&stable, "plain", "prj_stable", "");
            let before = (source_set(&source), source_set(&stable));
            let (runtime, ..) = serve(&directory, "dev", &[]);
            let root = directory.0.join("data/ycoding");
            let marker = directory.0.join("state/ycoding/stable-import-dev-v1.json");
            assert!(marker.is_file(), "{wal}");
            assert!(root.join("runtime-dev.lock").is_file(), "{wal}");
            assert!(!root.join("runtime.lock").exists(), "{wal}");
            stop(runtime);
            assert!(!root.join("analytics").exists(), "{wal}");
            assert_eq!(
                projects(&root.join("ycoding-dev.redb")),
                ["prj_dev"],
                "{wal}"
            );
            assert!(provenance(&root.join("ycoding-dev.redb")));
            assert!(!root.join("ycoding.redb").exists(), "{wal}");
            assert!(
                !directory
                    .0
                    .join("state/ycoding/stable-import-v1.json")
                    .exists(),
                "{wal}"
            );
            std::fs::remove_file(&marker).unwrap();
            let (runtime, ..) = serve(&directory, "dev", &[]);
            stop(runtime);
            assert!(
                marker.is_file(),
                "{wal}: marker loss recovers from the sealed journal"
            );
            assert_eq!(
                projects(&root.join("ycoding-dev.redb")),
                ["prj_dev"],
                "{wal}"
            );
            assert_eq!((source_set(&source), source_set(&stable)), before, "{wal}");
            release(held);
        }
    }

    #[test]
    fn channel_names_are_sanitized_in_slot_files() {
        let directory = Directory::new();
        closed(
            &directory.0.join("data/ycoding/ycoding-feat-x-y.db"),
            "plain",
            "prj_feature",
            "",
        );
        let (runtime, ..) = serve(&directory, "feat/x y", &[]);
        let root = directory.0.join("data/ycoding");
        assert!(root.join("runtime-feat-x-y.lock").is_file());
        stop(runtime);
        assert_eq!(
            projects(&root.join("ycoding-feat-x-y.redb")),
            ["prj_feature"]
        );
        assert!(
            directory
                .0
                .join("state/ycoding/stable-import-feat-x-y-v1.json")
                .is_file()
        );
    }

    #[test]
    fn channels_that_sanitize_alike_share_one_slot() {
        let directory = Directory::new();
        closed(
            &directory.0.join("data/ycoding/ycoding-a-b.db"),
            "plain",
            "prj_shared",
            "",
        );
        let (first, ..) = serve(&directory, "a/b", &[]);
        let mut contender = Runtime::spawn(configured(&directory, "a-b", &[]), &SERVE);
        assert!(
            contender.wait().success(),
            "both channels contend on one lease"
        );
        assert!(!directory.registration("a-b").exists());
        stop(first);
        let (second, ..) = serve(&directory, "a-b", &[]);
        stop(second);
        let root = directory.0.join("data/ycoding");
        assert_eq!(projects(&root.join("ycoding-a-b.redb")), ["prj_shared"]);
    }

    #[test]
    fn other_channel_slots_and_the_stable_slot_run_side_by_side_with_separate_leases() {
        let directory = Directory::new();
        let (dev, ..) = serve(&directory, "dev", &[]);
        let (local, ..) = serve(&directory, "local", &[]);
        let (stable, ..) = serve(&directory, "latest", &[]);
        let (beta, ..) = serve(&directory, "beta", &[]);
        let root = directory.0.join("data/ycoding");
        for lease in ["runtime-dev.lock", "runtime-local.lock", "runtime.lock"] {
            assert!(root.join(lease).is_file(), "{lease}");
        }
        assert!(directory.0.join("data/ycoding-beta/runtime.lock").is_file());
        assert!(root.join("ycoding-dev.redb").is_file());
        assert!(root.join("ycoding-local.redb").is_file());
        assert!(root.join("ycoding.redb").is_file());
        assert!(directory.0.join("data/ycoding-beta/ycoding.redb").is_file());
        let registration = std::fs::read_to_string(directory.registration("dev")).unwrap();
        let mut contender = Runtime::spawn(configured(&directory, "dev", &[]), &SERVE);
        assert!(contender.wait().success(), "the same slot has one lease");
        assert_eq!(
            std::fs::read_to_string(directory.registration("dev")).unwrap(),
            registration
        );
        for runtime in [dev, local, stable, beta] {
            stop(runtime);
        }
    }

    #[test]
    fn other_channel_absent_source_decision_survives_restart_and_marker_loss() {
        let directory = Directory::new();
        let marker = directory
            .0
            .join("state/ycoding/stable-import-local-v1.json");
        let (first, ..) = serve(&directory, "local", &[]);
        stop(first);
        assert!(marker.is_file());
        std::fs::remove_file(&marker).unwrap();
        let source = source_fixture(
            &directory.0.join("data/ycoding/ycoding-local.db"),
            "plain",
            "prj_late",
            "",
        );
        let (second, ..) = serve(&directory, "local", &[]);
        stop(second);
        assert!(marker.is_file());
        assert_eq!(
            projects(&directory.0.join("data/ycoding/ycoding-local.redb")),
            Vec::<String>::new()
        );
        release(source);
    }

    #[test]
    fn invalid_other_channel_source_fails_without_marker_and_can_retry() {
        let directory = Directory::new();
        let source = directory.0.join("data/ycoding/ycoding-dev.db");
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        std::fs::write(&source, b"not SQLite").unwrap();
        let command = configured(&directory, "dev", &[]);
        let (code, stderr) = finish(&directory, "dev", command);
        assert_eq!(code, Some(1), "{stderr}");
        assert_eq!(std::fs::read(&source).unwrap(), b"not SQLite");
        assert!(!directory.0.join("data/ycoding/ycoding-dev.redb").exists());
        assert!(
            !directory
                .0
                .join("state/ycoding/stable-import-dev-v1.json")
                .exists()
        );
        std::fs::remove_file(&source).unwrap();
        let (runtime, ..) = serve(&directory, "dev", &[]);
        stop(runtime);
    }

    #[test]
    fn explicit_source_is_imported_once_sealed_and_never_read_again() {
        for wal in [false, true] {
            let directory = Directory::new();
            let targets = mkdir(&directory.0.join("targets"), 0o755);
            let target = targets.join("imported.redb");
            let marker = targets.join("imported.redb.stable-import-v1.json");
            let legacy = directory.0.join("sources/legacy.db");
            let held = source_fixture(&legacy, if wal { "wal" } else { "plain" }, "prj_legacy", "");
            let stable = directory.0.join("data/ycoding/ycoding.db");
            closed(&stable, "plain", "prj_stable", "");
            let channel_source = directory.0.join("data/ycoding/ycoding-local.db");
            closed(&channel_source, "plain", "prj_local", "");
            let before = (
                source_set(&legacy),
                source_set(&stable),
                source_set(&channel_source),
            );
            let environment = variables(Some(utf8(&target)), Some(utf8(&legacy)));

            let (runtime, ..) = serve(&directory, "local", &environment);
            stop(runtime);
            assert!(marker.is_file(), "{wal}");
            assert_eq!(projects(&target), ["prj_legacy"], "{wal}");
            assert!(provenance(&target), "{wal}");
            assert_eq!(
                (
                    source_set(&legacy),
                    source_set(&stable),
                    source_set(&channel_source)
                ),
                before,
                "{wal}: source files and sidecars keep hashes and membership"
            );
            let root = directory.0.join("data/ycoding");
            assert!(!root.join("ycoding.redb").exists(), "{wal}");
            assert!(!root.join("ycoding-local.redb").exists(), "{wal}");
            assert!(
                !directory
                    .0
                    .join("state/ycoding/stable-import-local-v1.json")
                    .exists(),
                "{wal}"
            );
            assert_eq!(mode(&targets), 0o755, "{wal}");
            assert_eq!(staging(&targets), Vec::<String>::new(), "{wal}");

            release(held);
            for suffix in ["", "-wal", "-journal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", utf8(&legacy)));
            }
            let (runtime, ..) = serve(&directory, "local", &environment);
            stop(runtime);
            assert_eq!(
                projects(&target),
                ["prj_legacy"],
                "{wal}: the source is not read again"
            );

            let other = directory.0.join("sources/other.db");
            closed(&other, "plain", "prj_other", "");
            let changed = variables(Some(utf8(&target)), Some(utf8(&other)));
            let (runtime, ..) = serve(&directory, "local", &changed);
            stop(runtime);
            assert_eq!(
                projects(&target),
                ["prj_legacy"],
                "{wal}: a sealed store never reimports"
            );
        }
    }

    #[test]
    fn explicit_source_with_a_slot_path_target_uses_the_slot_companions() {
        let directory = Directory::new();
        let default = directory.0.join("data/ycoding/ycoding-dev.db");
        closed(&default, "plain", "prj_default", "");
        let default_hash = digest(&default);
        let legacy = directory.0.join("sources/legacy.db");
        closed(&legacy, "plain", "prj_legacy", "");
        let target = directory.0.join("data/ycoding/ycoding-dev.redb");
        let environment = variables(Some(utf8(&target)), Some(utf8(&legacy)));
        let (runtime, ..) = serve(&directory, "dev", &environment);
        stop(runtime);
        assert_eq!(projects(&target), ["prj_legacy"]);
        assert!(
            directory
                .0
                .join("state/ycoding/stable-import-dev-v1.json")
                .is_file()
        );
        assert!(
            !directory
                .0
                .join("data/ycoding/ycoding-dev.redb.stable-import-v1.json")
                .exists()
        );
        assert_eq!(digest(&default), default_hash);
    }

    #[test]
    fn explicit_import_publishes_resources_from_the_stable_data_root() {
        use ycoding_core::ycoding_schema::{DomainEncode, stringify_json};
        let directory = Directory::new();
        let stable_root = mkdir(&directory.0.join("data/ycoding"), 0o700);
        let attachments =
            ycoding_core::resources::attachment_store::Store::new(stable_root.clone()).unwrap();
        let content = attachments.import(b"synthetic attachment").unwrap();
        let attachment = attachments.absolute_path(&content).unwrap();
        let attachment_hash = digest(&attachment);
        let data = format!(
            "{{\"text\":\"synthetic\",\"files\":[{{\"mime\":\"text/plain\",\"content\":{}}}]}}",
            stringify_json(&content.encode())
        );
        let sql = format!(
            "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES('p','/synthetic',0,1,'[]'); INSERT INTO session(id,project_id,directory,title,time_created,time_updated) VALUES('ses-resource','p','/synthetic','fixture',0,1); INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES('msg-resource','ses-resource','user',1,0,1,'{data}');"
        );
        let legacy = directory.0.join("sources/legacy.db");
        closed(&legacy, "plain", "prj_legacy", &sql);
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("imported.redb");
        let environment = variables(Some(utf8(&target)), Some(utf8(&legacy)));
        let (runtime, ..) = serve(&directory, "beta", &environment);
        stop(runtime);
        assert_eq!(projects(&target), ["p", "prj_legacy"]);
        let published = ycoding_core::resources::attachment_store::Store::new(
            directory.0.join("data/ycoding-beta"),
        )
        .unwrap();
        assert_eq!(published.read(&content).unwrap(), b"synthetic attachment");
        assert_eq!(digest(&attachment), attachment_hash);
        assert!(!targets.join("attachments").exists());
    }

    #[test]
    fn unrecoverable_explicit_sources_fail_without_a_store_or_marker_and_can_retry() {
        for case in ["rollback-without-journal", "not-sqlite"] {
            let directory = Directory::new();
            let targets = mkdir(&directory.0.join("targets"), 0o755);
            let target = targets.join("imported.redb");
            let marker = targets.join("imported.redb.stable-import-v1.json");
            let legacy = directory.0.join("sources/legacy.db");
            if case == "not-sqlite" {
                std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
                std::fs::write(&legacy, b"not SQLite").unwrap();
            } else {
                closed(&legacy, "rollback", "prj_legacy", "");
            }
            let hash = digest(&legacy);
            let environment = variables(Some(utf8(&target)), Some(utf8(&legacy)));
            let command = configured(&directory, "local", &environment);
            let (code, stderr) = finish(&directory, "local", command);
            assert_eq!(code, Some(1), "{case}: {stderr}");
            let stderr = stderr.to_lowercase();
            assert!(!stderr.contains("beta"), "{case}: {stderr}");
            if case == "rollback-without-journal" {
                assert!(stderr.contains("journal"), "{stderr}");
            }
            assert_eq!(digest(&legacy), hash, "{case}");
            assert!(!target.exists(), "{case}");
            assert!(!marker.exists(), "{case}");
            assert_eq!(mode(&targets), 0o755, "{case}");

            std::fs::remove_file(&legacy).unwrap();
            closed(&legacy, "plain", "prj_retry", "");
            let (runtime, ..) = serve(&directory, "local", &environment);
            stop(runtime);
            assert_eq!(projects(&target), ["prj_retry"], "{case}");
            assert!(marker.is_file(), "{case}");
        }
    }

    #[test]
    fn sealed_stores_check_the_source_shape_but_never_read_the_source() {
        let directory = Directory::new();
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("imported.redb");
        let legacy = directory.0.join("sources/legacy.db");
        closed(&legacy, "plain", "prj_legacy", "");
        let first = variables(Some(utf8(&target)), Some(utf8(&legacy)));
        let (runtime, ..) = serve(&directory, "local", &first);
        stop(runtime);

        let relative = variables(Some(utf8(&target)), Some("relative/legacy.db"));
        let command = configured(&directory, "local", &relative);
        let before = tree(&directory.0);
        let (code, stderr) = finish(&directory, "local", command);
        assert_eq!(code, Some(2), "{stderr}");
        assert!(stderr.contains("YCODING_SQLITE_IMPORT_SOURCE"), "{stderr}");
        assert_eq!(tree(&directory.0), before);

        let missing = directory.0.join("sources/missing.db");
        let other = directory.0.join("sources/other.db");
        closed(&other, "plain", "prj_other", "");
        let legacy_hash = source_set(&legacy);
        let other_hash = source_set(&other);
        for value in [&missing, &other] {
            let environment = variables(Some(utf8(&target)), Some(utf8(value)));
            let (runtime, ..) = serve(&directory, "local", &environment);
            stop(runtime);
            assert_eq!(projects(&target), ["prj_legacy"]);
        }
        assert!(!missing.exists());
        assert_eq!(source_set(&legacy), legacy_hash);
        assert_eq!(source_set(&other), other_hash);

        let slot = Directory::new();
        closed(
            &slot.0.join("data/ycoding/ycoding-dev.db"),
            "plain",
            "prj_dev",
            "",
        );
        let (runtime, ..) = serve(&slot, "dev", &[]);
        stop(runtime);
        assert!(
            slot.0
                .join("state/ycoding/stable-import-dev-v1.json")
                .is_file()
        );
        let absolute = slot.0.join("sources/legacy.db");
        let command = configured(&slot, "dev", &variables(None, Some(utf8(&absolute))));
        let before = tree(&slot.0);
        let (code, stderr) = finish(&slot, "dev", command);
        assert_eq!(code, Some(2), "{stderr}");
        assert!(stderr.contains("YCODING_SQLITE_IMPORT_SOURCE"), "{stderr}");
        assert_eq!(tree(&slot.0), before);
    }

    #[test]
    fn marker_loss_recovers_from_the_sealed_journal_without_reading_the_source() {
        for variant in ["removed", "unset", "different", "changed"] {
            let directory = Directory::new();
            let targets = mkdir(&directory.0.join("targets"), 0o755);
            let target = targets.join("imported.redb");
            let marker = targets.join("imported.redb.stable-import-v1.json");
            let legacy = directory.0.join("sources/legacy.db");
            closed(&legacy, "plain", "prj_legacy", "");
            let other = directory.0.join("sources/other.db");
            closed(&other, "plain", "prj_other", "");
            let first = variables(Some(utf8(&target)), Some(utf8(&legacy)));
            let (runtime, ..) = serve(&directory, "local", &first);
            stop(runtime);

            write_project(&target, "prj_ack");
            std::fs::remove_file(&marker).unwrap();
            for suffix in ["", "-wal", "-journal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", utf8(&legacy)));
            }
            if variant == "changed" {
                closed(&legacy, "plain", "prj_changed", "");
            }
            let other_hash = source_set(&other);
            let recovery = match variant {
                "removed" => variables(Some(utf8(&target)), Some(utf8(&legacy))),
                "unset" => variables(Some(utf8(&target)), None),
                "changed" => variables(Some(utf8(&target)), Some(utf8(&legacy))),
                _ => variables(Some(utf8(&target)), Some(utf8(&other))),
            };
            let (runtime, ..) = serve(&directory, "local", &recovery);
            stop(runtime);
            assert!(marker.is_file(), "{variant}");
            assert_eq!(
                projects(&target),
                ["prj_ack", "prj_legacy"],
                "{variant}: acknowledged records survive and nothing is reimported"
            );
            assert_eq!(legacy.exists(), variant == "changed", "{variant}");
            assert_eq!(source_set(&other), other_hash, "{variant}");
            assert_eq!(staging(&targets), Vec::<String>::new(), "{variant}");
        }
    }

    #[test]
    fn interrupted_import_is_never_replaced_by_an_empty_store() {
        let directory = Directory::new();
        let targets = mkdir(&directory.0.join("targets"), 0o755);
        let target = targets.join("imported.redb");
        let marker = targets.join("imported.redb.stable-import-v1.json");
        let legacy = directory.0.join("sources/legacy.db");
        closed(&legacy, "rollback", "prj_legacy", "");
        let environment = variables(Some(utf8(&target)), Some(utf8(&legacy)));
        let command = configured(&directory, "local", &environment);
        let (code, stderr) = finish(&directory, "local", command);
        assert_eq!(code, Some(1), "{stderr}");
        assert!(
            targets
                .join("imported.redb.stable-import-v1.stage-v2")
                .is_file(),
            "the interrupted import leaves its journal"
        );

        let missing = directory.0.join("sources/missing.db");
        for value in [None, Some(utf8(&missing))] {
            let command = configured(&directory, "local", &variables(Some(utf8(&target)), value));
            let (code, stderr) = finish(&directory, "local", command);
            assert_eq!(code, Some(1), "{value:?}: {stderr}");
            assert!(!target.exists(), "{value:?}");
            assert!(!marker.exists(), "{value:?}");
        }

        std::fs::remove_file(&legacy).unwrap();
        closed(&legacy, "plain", "prj_retry", "");
        let (runtime, ..) = serve(&directory, "local", &environment);
        stop(runtime);
        assert_eq!(projects(&target), ["prj_retry"]);
        assert!(marker.is_file());
    }

    #[test]
    fn blank_and_unset_channels_resolve_to_local_and_use_its_slot() {
        for variant in ["blank", "unset", "blank-with-selector"] {
            let directory = Directory::new();
            let stable = directory.0.join("data/ycoding/ycoding.db");
            let local = directory.0.join("data/ycoding/ycoding-local.db");
            closed(&stable, "plain", "prj_stable", "");
            closed(&local, "plain", "prj_local", "");
            let hashes = (source_set(&stable), source_set(&local));
            let mut command = configured(&directory, "", &[]);
            if variant == "unset" {
                command.env_remove("YCODING_CHANNEL");
            }
            if variant == "blank-with-selector" {
                command.env("YCODING_DISABLE_CHANNEL_DB", "1");
            }
            let (runtime, ..) = start(&directory, command, "local");
            stop(runtime);
            let root = directory.0.join("data/ycoding");
            let marker = directory
                .0
                .join("state/ycoding/stable-import-local-v1.json");
            if variant == "blank-with-selector" {
                assert_eq!(
                    projects(&root.join("ycoding.redb")),
                    Vec::<String>::new(),
                    "{variant}"
                );
                assert!(root.join("runtime.lock").is_file(), "{variant}");
                assert!(!root.join("ycoding-local.redb").exists(), "{variant}");
                assert!(!root.join("runtime-local.lock").exists(), "{variant}");
                assert!(!marker.exists(), "{variant}");
            } else {
                assert_eq!(
                    projects(&root.join("ycoding-local.redb")),
                    ["prj_local"],
                    "{variant}"
                );
                assert!(root.join("runtime-local.lock").is_file(), "{variant}");
                assert!(marker.is_file(), "{variant}");
                assert!(!root.join("ycoding.redb").exists(), "{variant}");
                assert!(!root.join("runtime.lock").exists(), "{variant}");
            }
            assert_eq!(
                (source_set(&stable), source_set(&local)),
                hashes,
                "{variant}"
            );
        }
    }
}
