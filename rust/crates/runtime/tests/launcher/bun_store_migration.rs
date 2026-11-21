use super::{launcher, stable_sources, support};
use launcher::{Directory, Runtime};
use prost::Message;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use support::{Client, basic, machine, session_scope, success, text, units};
use ycoding_core::ycoding_store::{Metadata, Options, Store, native};
use ycoding_protocol::v5;

const VERSION: &str = "0.12.0";
const PASSWORD: &str = "synthetic-migration-fixture";
const IDS: &[&str] = &[
    "ses_legacy_child",
    "ses_legacy_root",
    "ses_legacy_standalone",
];
const STANDALONE_PROJECT: &str = "proj_standalone_sessions";

fn fixture() -> (Directory, PathBuf, PathBuf, PathBuf) {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = std::env::var_os("YCODING_MIGRATION_TEST_ROOT")
        .map_or_else(std::env::temp_dir, PathBuf::from);
    let directory = Directory(parent.join(format!(
        "ycoding-bun-migration-{}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    let root = directory.0.join("project");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let settings = directory.0.join("config/ycoding/ycoding.json");
    fs::create_dir_all(settings.parent().unwrap()).unwrap();
    fs::write(
        &settings,
        r#"{"default_agent":"god","migration_fixture_unknown":true}"#,
    )
    .unwrap();
    let source = directory.0.join("data/ycoding/ycoding.db");
    let target = source.with_extension("redb");
    (directory, source, target, root)
}

fn start(directory: &Directory, project: &Path) -> Runtime {
    let mut command = directory.command(VERSION, "latest");
    command
        .current_dir(project)
        .env("YCODING_PASSWORD", PASSWORD);
    Runtime::spawn(command, &["serve", "--stdio", "--port", "0"])
}

async fn open(directory: &Directory, project: &Path) -> (Runtime, Client) {
    let runtime = start(directory, project);
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

async fn session_ids(client: &mut Client) -> Vec<String> {
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
    let mut ids = listed
        .data
        .data
        .items
        .iter()
        .map(|row| units(&row.id))
        .collect::<Vec<_>>();
    ids.sort();
    ids
}

fn bun_source(
    directory: &Directory,
    source: &Path,
    project: &Path,
    extra: &str,
) -> (Child, PathBuf) {
    let location = project.to_str().unwrap().replace('\'', "''");
    let standalone = directory.0.join("state/ycoding/standalone-sessions");
    fs::create_dir_all(&standalone).unwrap();
    let standalone = standalone.canonicalize().unwrap();
    let standalone_root = standalone.to_str().unwrap().replace('\'', "''");
    let bun = stable_sources::source_fixture(
        source,
        "wal",
        "prj_legacy",
        &format!(
            r#"
            INSERT INTO migration VALUES('20261117061015_review-pinned-indexes',1);
            UPDATE project SET worktree='{location}',name='Bun fixture' WHERE id='prj_legacy';
            INSERT INTO project_directory VALUES('prj_legacy','{location}','root',NULL,1);
            INSERT INTO session(id,project_id,directory,title,time_created,time_updated,autonomy,autonomy_revision)
              VALUES('ses_legacy_root','prj_legacy','{location}','Bun root',unixepoch()*1000,unixepoch()*1000,
                '{{"mode":"normal","permissions":"auto","guardrails":"manual","answers":"auto"}}',7);
            INSERT INTO session(id,project_id,directory,title,time_created,time_updated,parent_id)
              VALUES('ses_legacy_child','prj_legacy','{location}','Bun child',unixepoch()*1000,unixepoch()*1000,'ses_legacy_root');
            INSERT INTO project(id,worktree,time_created,time_updated,sandboxes)
              VALUES('{STANDALONE_PROJECT}','{standalone_root}',1,2,'[]');
            INSERT INTO session(id,project_id,directory,title,time_created,time_updated,scope)
              VALUES('ses_legacy_standalone','{STANDALONE_PROJECT}','{standalone_root}','Bun scratch',unixepoch()*1000,unixepoch()*1000,'standalone');
            INSERT INTO event_sequence(aggregate_id,seq) VALUES('ses_legacy_root',4);
            INSERT INTO session_message VALUES('msg_legacy_answer','ses_legacy_root','assistant',4,3,6,
              '{{"agent":"god","model":{{"providerID":"fixture","id":"fixture-model"}},"time":{{"created":3,"completed":6}},"content":[{{"type":"text","text":"Imported answer","time":{{"created":4,"completed":5}},"breaks":[{{"offset":8,"after":"msg_legacy_second"}}]}}]}}');
            INSERT INTO session_message VALUES('msg_legacy_second','ses_legacy_root','synthetic',3,2,2,
              '{{"text":"Imported second line","time":{{"created":2}}}}');
            INSERT INTO session_message VALUES('msg_legacy_first','ses_legacy_root','synthetic',2,1,1,
              '{{"text":"Imported first line","time":{{"created":1}}}}');
            INSERT INTO telemetry_consent VALUES(1,0,1,1000);
            {extra}
            "#
        ),
    );
    (bun, standalone)
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

async fn get(client: &mut Client, id: &str) -> v5::SessionGetResult {
    success(
        client
            .call(
                "session.get",
                session_scope(id),
                v5::SessionGetRequest {
                    params: v5::SessionGetRequestParams {
                        session_id: text(id),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    )
}

#[tokio::test]
async fn stable_first_run_imports_the_bun_transcript_without_touching_rollback() {
    let (directory, source, target, project) = fixture();
    let (bun, standalone) = bun_source(&directory, &source, &project, "");
    let wal = source.with_file_name("ycoding.db-wal");
    let settings = directory.0.join("config/ycoding/ycoding.json");
    let before = [&source, &wal, &settings].map(|path| fs::read(path).unwrap());
    assert!(!target.exists());
    let (runtime, mut client) = open(&directory, &project).await;
    assert_eq!(session_ids(&mut client).await, IDS);
    let root = get(&mut client, "ses_legacy_root").await.data;
    assert_eq!(units(&root.title), "Bun root");
    assert_eq!(units(&root.project_id), "prj_legacy");
    assert_eq!(units(&root.location.directory), project.to_str().unwrap());
    let child = get(&mut client, "ses_legacy_child").await.data;
    assert_eq!(units(&child.parent_id.unwrap()), "ses_legacy_root");
    assert_eq!(units(&child.title), "Bun child");
    let scratch = get(&mut client, "ses_legacy_standalone").await.data;
    assert_eq!(units(&scratch.title), "Bun scratch");
    assert_eq!(units(&scratch.project_id), STANDALONE_PROJECT);
    assert_eq!(
        units(&scratch.location.directory),
        standalone.to_str().unwrap()
    );
    assert_eq!(root.scope, 1);
    assert_eq!(scratch.scope, 2);
    let snapshot: v5::SessionSnapshotResult = success(
        client
            .call(
                "session.snapshot",
                session_scope("ses_legacy_root"),
                v5::SessionSnapshotRequest {
                    params: v5::SessionSnapshotRequestParams {
                        session_id: text("ses_legacy_root"),
                    },
                    query: v5::SessionSnapshotQuery::default(),
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert_eq!(snapshot.data.watermark.seq, Some(4));
    let mut messages = snapshot.data.messages.items;
    let Some(v5::session_message_info::Kind::Value8(answer)) = messages.pop().unwrap().kind else {
        panic!("expected the imported assistant message last");
    };
    assert_eq!(units(&answer.id), "msg_legacy_answer");
    let [part] = &answer.content.items[..] else {
        panic!("expected one assistant text part");
    };
    let Some(v5::session_message_assistant_content_item::Kind::Value1(part)) = &part.kind else {
        panic!("expected an assistant text part");
    };
    assert_eq!(units(&part.text), "Imported answer");
    assert_eq!(
        part.time
            .as_ref()
            .map(|time| (time.created, time.completed)),
        Some((4.0, Some(5.0)))
    );
    let breaks = &part.breaks.as_ref().unwrap().items;
    assert_eq!(breaks.len(), 1);
    assert_eq!(breaks[0].offset, 8);
    assert_eq!(units(&breaks[0].after), "msg_legacy_second");
    let messages = messages
        .into_iter()
        .map(|info| {
            let Some(v5::session_message_info::Kind::Value4(message)) = info.kind else {
                panic!("expected a synthetic message");
            };
            (units(&message.id), units(&message.text))
        })
        .collect::<Vec<_>>();
    assert_eq!(
        messages,
        [
            ("msg_legacy_first".into(), "Imported first line".into()),
            ("msg_legacy_second".into(), "Imported second line".into()),
        ]
    );
    let autonomy: v5::SessionAutonomyGetResult = success(
        client
            .call(
                "session.autonomy.get",
                session_scope("ses_legacy_root"),
                v5::SessionAutonomyGetRequest {
                    params: v5::SessionAutonomyGetRequestParams {
                        session_id: text("ses_legacy_root"),
                    },
                }
                .encode_to_vec(),
            )
            .await,
    );
    assert_eq!(autonomy.data.permissions, 3);
    assert_eq!(autonomy.data.guardrails, 1);
    assert_eq!(autonomy.data.answers, 3);
    let location = project.to_str().unwrap();
    let config: v5::ConfigDiagnosticsResult = support::wire::ask(
        &mut client,
        "config.diagnostics",
        support::wire::location_scope(location),
        v5::ConfigDiagnosticsRequest {
            query: support::wire::query(location, None),
        },
    )
    .await;
    assert!(config.data.items.iter().any(|item| {
        item.json_path
            .as_ref()
            .is_some_and(|path| units(path) == "$.migration_fixture_unknown")
    }));
    let consent: v5::TelemetryConsentGetResult = support::wire::ask(
        &mut client,
        "telemetry.consent.get",
        machine(),
        v5::TelemetryConsentGetRequest {},
    )
    .await;
    let consent = consent.data.consent.unwrap();
    assert!(!consent.enabled);
    assert_eq!(consent.decided_at, 1000);
    stop(runtime, client);
    assert_eq!(
        [&source, &wal, &settings].map(|path| fs::read(path).unwrap()),
        before
    );
    assert!(Command::new("python3").args(["-c", r#"
import sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro', uri=True)
assert db.execute('PRAGMA integrity_check').fetchall()==[('ok',)]
assert db.execute('SELECT id FROM session ORDER BY id').fetchall()==[('ses_legacy_child',),('ses_legacy_root',),('ses_legacy_standalone',)]
"#]).arg(&source).status().unwrap().success());
    close_bun(bun);
}

#[tokio::test]
async fn initialized_empty_store_imports_in_place_and_does_not_repeat() {
    let (directory, source, target, project) = fixture();
    let (runtime, mut client) = open(&directory, &project).await;
    assert!(session_ids(&mut client).await.is_empty());
    stop(runtime, client);
    let identity = native_identity(&target);
    let (bun, _) = bun_source(&directory, &source, &project, "");
    let (runtime, mut client) = open(&directory, &project).await;
    assert_eq!(session_ids(&mut client).await, IDS);
    stop(runtime, client);
    assert_eq!(native_identity(&target), identity);
    close_bun(bun);
    assert!(Command::new("python3").args(["-c", r#"
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO session(id,project_id,directory,title,time_created,time_updated) SELECT 'ses_bun_after_cutover',project_id,directory,'New Bun session',time_created,time_updated FROM session WHERE id='ses_legacy_root'")
"#]).arg(&source).status().unwrap().success());
    let (runtime, mut client) = open(&directory, &project).await;
    assert_eq!(session_ids(&mut client).await, IDS);
    stop(runtime, client);
    assert_eq!(native_identity(&target), identity);
}

#[tokio::test]
async fn interrupted_snapshot_recovers_without_a_partial_native_store() {
    interrupted_snapshot(false).await;
}

#[tokio::test]
async fn interrupted_snapshot_recovers_with_an_existing_empty_store() {
    interrupted_snapshot(true).await;
}

async fn interrupted_snapshot(existing: bool) {
    let (directory, source, target, project) = fixture();
    let identity = if existing {
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let identity = [9; 16];
        Store::initialize(
            &target,
            Options::core(),
            native::catalog(native::DatabaseKind::Core),
            Metadata::new(identity, 1),
        )
        .unwrap()
        .shutdown()
        .unwrap();
        Some(identity)
    } else {
        None
    };
    let (bun, _) = bun_source(
        &directory,
        &source,
        &project,
        "CREATE TABLE snapshot_padding(payload BLOB); INSERT INTO snapshot_padding VALUES(zeroblob(16777216));",
    );
    let wal = source.with_file_name("ycoding.db-wal");
    let before = [&source, &wal].map(|path| fs::read(path).unwrap());
    let stage = target.with_file_name("ycoding.redb.bun-import-v1");
    let mut runtime = start(&directory, &project);
    let deadline = Instant::now() + Duration::from_secs(30);
    while !stage.join("source.db").is_file() {
        assert!(runtime.child.try_wait().unwrap().is_none());
        assert!(
            Instant::now() < deadline,
            "runtime did not begin copying the Bun snapshot"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    runtime.child.kill().unwrap();
    assert!(!runtime.wait().success());
    assert!(stage.join(".owned").is_file());
    assert_eq!(target.exists(), existing);
    assert_eq!([&source, &wal].map(|path| fs::read(path).unwrap()), before);
    let (runtime, mut client) = open(&directory, &project).await;
    assert_eq!(session_ids(&mut client).await, IDS);
    stop(runtime, client);
    assert!(!stage.exists());
    assert_eq!([&source, &wal].map(|path| fs::read(path).unwrap()), before);
    if let Some(identity) = identity {
        assert_eq!(native_identity(&target), identity);
    }
    close_bun(bun);
}
