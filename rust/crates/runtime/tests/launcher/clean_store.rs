use super::{launcher, stable_sources, support};
use launcher::{Directory, Runtime};
use prost::Message;
use std::{fs, path::Path, process::Child};
use support::{Client, basic, machine, success};
use ycoding_core::ycoding_store::{Metadata, Options, Store, native};
use ycoding_protocol::v5;

const PASSWORD: &str = "synthetic-clean-store-fixture";

async fn open(directory: &Directory) -> (Runtime, Client) {
    let mut command = directory.command("test-v1", "latest");
    command.env("YCODING_PASSWORD", PASSWORD);
    let runtime = Runtime::spawn(command, &["serve", "--stdio", "--port", "0"]);
    let ready = ycoding_core::ycoding_schema::parse_json(&runtime.ready()).unwrap();
    let address = launcher::string(&ready, "url")
        .strip_prefix("http://")
        .unwrap()
        .parse()
        .unwrap();
    let client = Client::open(address, &[("authorization", basic(PASSWORD))])
        .await
        .unwrap();
    (runtime, client)
}

async fn assert_no_sessions(client: &mut Client) {
    let listed: v5::SessionListResult = success(
        client
            .call(
                "session.list",
                machine(),
                v5::SessionListRequest {
                    query: v5::SessionsQuery::default(),
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert!(listed.data.data.items.is_empty());
}

#[tokio::test]
async fn startup_reports_readiness_and_recovery_durations_at_info() {
    let directory = Directory::new();
    let (runtime, client) = open(&directory).await;
    stop(runtime, client);
    let log = fs::read_to_string(directory.0.join("data/ycoding/log/ycoding.log")).unwrap();
    for stage in [
        "launch_admission",
        "store_prepare",
        "store_open",
        "model_catalog",
        "interrupted_steps",
        "shell_ledger",
        "managed_tasks",
        "project_notification_recovery",
        "project_admitted_inputs",
        "pending_forms",
        "service_composition",
        "listener_publication",
        "maintenance",
        "ready",
    ] {
        let field = format!("stage={stage}");
        assert!(
            log.lines().any(|line| {
                let fields = line.split_ascii_whitespace();
                fields.clone().any(|value| value == "level=INFO")
                    && fields.clone().any(|value| value == field)
                    && fields.clone().any(|value| value.starts_with("rss_status="))
                    && fields
                        .clone()
                        .any(|value| value.starts_with("peak_rss_status="))
                    && (!cfg!(target_os = "macos")
                        || fields
                            .clone()
                            .filter_map(|value| value.strip_prefix("rss_bytes="))
                            .any(|value| value.parse::<u64>().is_ok_and(|rss| rss > 0)))
                    && fields
                        .filter_map(|value| value.strip_prefix("duration_ms="))
                        .any(|value| value.parse::<u64>().is_ok())
            }),
            "missing INFO duration or memory sample for {stage}"
        );
    }
}

#[tokio::test]
async fn ready_runtime_serves_session_inventory_before_optional_maintenance() {
    let directory = Directory::new();
    let (runtime, mut client) = open(&directory).await;
    assert_no_sessions(&mut client).await;
    stop(runtime, client);
    let log = fs::read_to_string(directory.0.join("data/ycoding/log/ycoding.log")).unwrap();
    let stage = |name| {
        log.lines()
            .position(|line| {
                line.split_ascii_whitespace()
                    .any(|field| field.strip_prefix("stage=") == Some(name))
            })
            .unwrap_or_else(|| panic!("missing {name} stage"))
    };
    let ready = stage("ready");
    assert!(stage("store_prepare") < stage("store_open"));
    assert!(stage("store_open") < ready);
    assert!(ready < stage("maintenance"));
    assert!(
        !log.lines()
            .take(ready)
            .any(|line| line.contains("location services booted"))
    );
}

fn bun_source(source: &Path) -> Child {
    stable_sources::source_fixture(
        source,
        "wal",
        "prj_legacy",
        "INSERT INTO migration VALUES('20261117061015_review-pinned-indexes',1);
         INSERT INTO session(id,project_id,directory,title,time_created,time_updated)
         VALUES('ses_legacy','prj_legacy','/synthetic','Bun session',unixepoch()*1000,unixepoch()*1000);",
    )
}

fn stop(mut runtime: Runtime, client: Client) {
    drop(client);
    drop(runtime.child.stdin.take());
    assert!(runtime.wait().success());
}

fn close_bun(mut child: Child) {
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
}

fn native_identity(target: &Path) -> [u8; 16] {
    let store = Store::open(
        target,
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
    )
    .unwrap();
    let identity = store.metadata().database_identity;
    store.shutdown().unwrap();
    identity
}

#[tokio::test]
async fn stable_first_run_keeps_bun_transcripts_and_sidecars_untouched() {
    let directory = Directory::new();
    let source = directory.0.join("data/ycoding/ycoding.db");
    let bun = bun_source(&source);
    let files = [
        source.clone(),
        source.with_file_name("ycoding.db-wal"),
        source.with_file_name("ycoding.db-shm"),
        source.with_file_name("ycoding.db-journal"),
    ];
    fs::write(&files[3], b"synthetic rollback sidecar").unwrap();
    let before = files.each_ref().map(|path| fs::read(path).unwrap());
    let target = source.with_file_name("core.redb");
    let (runtime, mut client) = open(&directory).await;
    assert_no_sessions(&mut client).await;
    stop(runtime, client);
    assert!(target.is_file());
    assert!(!source.with_extension("redb").exists());
    assert_eq!(files.each_ref().map(|path| fs::read(path).unwrap()), before);
    let identity = native_identity(&target);
    let (runtime, mut client) = open(&directory).await;
    assert_no_sessions(&mut client).await;
    stop(runtime, client);
    assert_eq!(native_identity(&target), identity);
    assert_eq!(files.each_ref().map(|path| fs::read(path).unwrap()), before);
    close_bun(bun);
}

#[tokio::test]
async fn existing_empty_native_store_ignores_bun_data_added_after_startup() {
    let directory = Directory::new();
    let (runtime, mut client) = open(&directory).await;
    assert_no_sessions(&mut client).await;
    stop(runtime, client);
    let target = directory.0.join("data/ycoding/core.redb");
    let identity = native_identity(&target);
    let source = directory.0.join("data/ycoding/ycoding.db");
    let bun = bun_source(&source);
    let before = fs::read(&source).unwrap();
    let wal = source.with_file_name("ycoding.db-wal");
    let before_wal = fs::read(&wal).unwrap();
    let (runtime, mut client) = open(&directory).await;
    assert_no_sessions(&mut client).await;
    stop(runtime, client);
    assert_eq!(native_identity(&target), identity);
    assert_eq!(fs::read(&source).unwrap(), before);
    assert_eq!(fs::read(&wal).unwrap(), before_wal);
    close_bun(bun);
}

#[tokio::test]
async fn stale_bun_import_staging_is_left_untouched() {
    let directory = Directory::new();
    let target = directory.0.join("data/ycoding/core.redb");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    Store::initialize(
        &target,
        Options::core(),
        native::catalog(native::DatabaseKind::Core),
        Metadata::new([9; 16], 1),
    )
    .unwrap()
    .shutdown()
    .unwrap();
    let stages = ["core.redb.bun-import-v1", "ycoding.redb.bun-import-v1"]
        .map(|name| target.with_file_name(name));
    for stage in &stages {
        fs::create_dir_all(stage).unwrap();
        fs::write(stage.join(".owned"), b"ycoding-bun-import-v1\n").unwrap();
        fs::write(stage.join("source.db"), b"unfinished private snapshot").unwrap();
    }
    let before = stages
        .each_ref()
        .map(|stage| [".owned", "source.db"].map(|name| fs::read(stage.join(name)).unwrap()));
    let (runtime, mut client) = open(&directory).await;
    assert_no_sessions(&mut client).await;
    stop(runtime, client);
    assert_eq!(native_identity(&target), [9; 16]);
    assert!(!target.with_file_name("ycoding.redb").exists());
    assert_eq!(
        stages.each_ref().map(|stage| {
            [".owned", "source.db"].map(|name| fs::read(stage.join(name)).unwrap())
        }),
        before
    );
}
