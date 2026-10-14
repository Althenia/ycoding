use super::{
    ImportError, LaunchError, LosslessString, Options, Phase, Store, activate, import, kind_name,
    parse_json, read_selection, store_options, stringify_json,
};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use ycoding_core::ycoding_schema::DomainEncode;
use ycoding_core::ycoding_store::artifacts;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ycoding-activation-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn source(&self) -> PathBuf {
        self.0.join("stable/ycoding.db")
    }
    fn file(&self) -> PathBuf {
        self.0.join("beta/ycoding.redb")
    }
    fn marker(&self) -> PathBuf {
        self.0.join("state/stable-import-v1.json")
    }
    fn create(&self, kind: import::DatabaseKind, sql: &str) {
        std::fs::create_dir_all(self.source().parent().unwrap()).unwrap();
        let script = "import sqlite3,sys,re\ndb=sqlite3.connect(sys.argv[1])\ndb.execute('PRAGMA journal_mode=WAL')\nif sys.argv[2]=='core':\n schema=open(sys.argv[3]).read()\n for sql in re.findall(r'`((?:\\\\.|[^`])*)`',schema): db.executescript(sql.replace('\\\\`','`'))\ndb.executescript(\"CREATE TABLE migration(id TEXT PRIMARY KEY,time_completed INTEGER NOT NULL);CREATE TABLE database_format(id TEXT PRIMARY KEY,time_created INTEGER NOT NULL);INSERT INTO database_format VALUES('current-2026-08-04',0);INSERT INTO migration VALUES('baseline',1);\")\ndb.executescript(sys.argv[4]);db.commit();db.close()";
        let output = Command::new("python3")
            .args(["-c", script])
            .arg(self.source())
            .arg(kind_name(kind))
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../../packages/core/src/database/schema.gen.ts"
            ))
            .arg(sql)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fn activate(
        &self,
        kind: import::DatabaseKind,
        progress: impl FnMut(Phase) -> Result<(), LaunchError>,
    ) -> Result<(), LaunchError> {
        activate(
            &self.source(),
            &self.file(),
            &self.marker(),
            &self.0.join("tmp"),
            kind,
            progress,
        )
    }
    fn rows(&self, kind: import::DatabaseKind) -> Vec<artifacts::Migration> {
        let store = Store::open(self.file(), store_options(kind), import::catalog(kind)).unwrap();
        let snapshot = store.snapshot().unwrap();
        let rows = snapshot
            .scan::<artifacts::MigrationTable>(
                std::ops::Bound::Unbounded,
                std::ops::Bound::Unbounded,
                100,
            )
            .unwrap();
        drop(snapshot);
        store.shutdown().unwrap();
        rows
    }
    fn sql(&self, sql: &str) {
        let output = Command::new("python3").args(["-c", "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.executescript(sys.argv[2]);db.commit();db.close()"])
            .arg(self.source()).arg(sql).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn beta_write(fixture: &Fixture) {
    let store = Store::open(
        fixture.file(),
        Options::core(),
        import::catalog(import::DatabaseKind::Bootstrap),
    )
    .unwrap();
    store
        .submit(|tx| {
            artifacts::MigrationTable::put(
                tx,
                &artifacts::Migration {
                    id: "beta-write".into(),
                    time_completed: 42,
                },
            )
        })
        .unwrap()
        .wait()
        .unwrap();
    store.shutdown().unwrap();
}

#[test]
fn cancelled_activation_resumes_each_boundary_and_preserves_post_publication_writes() {
    for phase in [
        Phase::Copied,
        Phase::Imported(import::Progress::Created),
        Phase::Imported(import::Progress::Loaded("migration")),
        Phase::Imported(import::Progress::Validating),
        Phase::Imported(import::Progress::Verifying),
        Phase::Imported(import::Progress::Verified("migration")),
        Phase::Imported(import::Progress::Complete),
        Phase::Sealed,
        Phase::ResourcesPublished,
        Phase::StorePublished,
        Phase::MarkerPublished,
    ] {
        let fixture = Fixture::new();
        fixture.create(import::DatabaseKind::Bootstrap, "");
        let before = std::fs::read(fixture.source()).unwrap();
        assert!(
            fixture
                .activate(import::DatabaseKind::Bootstrap, |current| {
                    if current == phase {
                        if matches!(current, Phase::StorePublished | Phase::MarkerPublished) {
                            beta_write(&fixture);
                        }
                        return Err(LaunchError::Usage("synthetic cancellation".into()));
                    }
                    Ok(())
                })
                .is_err()
        );
        if !matches!(phase, Phase::StorePublished | Phase::MarkerPublished) {
            assert!(!fixture.file().exists());
        }
        fixture
            .activate(import::DatabaseKind::Bootstrap, |_| Ok(()))
            .unwrap();
        let rows = fixture.rows(import::DatabaseKind::Bootstrap);
        assert_eq!(
            rows.len(),
            if matches!(phase, Phase::StorePublished | Phase::MarkerPublished) {
                2
            } else {
                1
            }
        );
        assert_eq!(std::fs::read(fixture.source()).unwrap(), before);
        if rows.len() == 2 {
            assert!(
                rows.iter()
                    .any(|row| row.id.as_str() == Some("beta-write") && row.time_completed == 42)
            );
        }
    }
}

#[test]
fn changed_original_source_starts_a_new_generation_not_a_stale_resume() {
    let fixture = Fixture::new();
    fixture.create(import::DatabaseKind::Bootstrap, "");
    assert!(
        fixture
            .activate(import::DatabaseKind::Bootstrap, |phase| {
                if phase == Phase::Imported(import::Progress::Loaded("migration")) {
                    Err(LaunchError::Usage("interrupt".into()))
                } else {
                    Ok(())
                }
            })
            .is_err()
    );
    let prior = read_selection(
        &fixture.marker().with_extension("stage-v2"),
        import::DatabaseKind::Bootstrap,
    )
    .unwrap()
    .id;
    let output = Command::new("python3").args(["-c", "import sqlite3,sys;db=sqlite3.connect(sys.argv[1]);db.execute('UPDATE migration SET time_completed=2');db.commit();db.close()"])
        .arg(fixture.source()).output().unwrap();
    assert!(output.status.success());
    fixture
        .activate(import::DatabaseKind::Bootstrap, |_| Ok(()))
        .unwrap();
    assert_ne!(
        read_selection(&fixture.marker(), import::DatabaseKind::Bootstrap)
            .unwrap()
            .id,
        prior
    );
    assert_eq!(
        fixture.rows(import::DatabaseKind::Bootstrap)[0].time_completed,
        2
    );
}

#[test]
fn absent_source_decision_survives_interruption_and_later_stable_creation() {
    let fixture = Fixture::new();
    assert!(
        fixture
            .activate(import::DatabaseKind::Bootstrap, |phase| {
                if phase == Phase::Sealed {
                    Err(LaunchError::Usage("interrupt".into()))
                } else {
                    Ok(())
                }
            })
            .is_err()
    );
    fixture.create(import::DatabaseKind::Bootstrap, "");
    fixture
        .activate(import::DatabaseKind::Bootstrap, |_| Ok(()))
        .unwrap();
    assert!(fixture.rows(import::DatabaseKind::Bootstrap).is_empty());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(fixture.file())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    std::fs::remove_file(fixture.marker()).unwrap();
    fixture
        .activate(import::DatabaseKind::Bootstrap, |_| Ok(()))
        .unwrap();
    assert!(fixture.rows(import::DatabaseKind::Bootstrap).is_empty());
}

#[test]
fn managed_resources_are_reachable_and_never_recopied_over_beta_writes() {
    let fixture = Fixture::new();
    fixture.create(import::DatabaseKind::Core, "");
    let attachments = ycoding_core::resources::attachment_store::Store::new(
        fixture.source().parent().unwrap().to_path_buf(),
    )
    .unwrap();
    let attachment = attachments.import(b"synthetic attachment").unwrap();
    let artifact = "project-artifacts/12345678-1234-1234-1234-123456789abc/versions/test.md";
    std::fs::create_dir_all(
        fixture
            .source()
            .parent()
            .unwrap()
            .join(artifact)
            .parent()
            .unwrap(),
    )
    .unwrap();
    std::fs::write(
        fixture.source().parent().unwrap().join(artifact),
        "source artifact",
    )
    .unwrap();
    let digest = import::file_fingerprint(&fixture.source().parent().unwrap().join(artifact))
        .unwrap()
        .0;
    fixture.sql(&format!("{} INSERT INTO project_artifact_scope VALUES ('pas_test','project','12345678-1234-1234-1234-123456789abc',0,1); INSERT INTO project_artifact_project_scope(scope_id,project_id) VALUES('pas_test','p'); INSERT INTO project_artifact(scope_id,kind,artifact_id,revision,stage,current_version_id,time_created,time_updated) VALUES('pas_test','skill','test',0,'active','pav_test',0,1); INSERT INTO project_artifact_version(id,scope_id,kind,artifact_id,state,content_digest,content_relpath,source,time_created,time_state_changed) VALUES('pav_test','pas_test','skill','test','active','{digest}','versions/test.md','user',0,1);", attachment_sql(&attachment)));
    fixture
        .activate(import::DatabaseKind::Core, |_| Ok(()))
        .unwrap();
    let beta = fixture.file().parent().unwrap().to_path_buf();
    let reader = ycoding_core::resources::attachment_store::Store::new(beta.clone()).unwrap();
    assert_eq!(reader.read(&attachment).unwrap(), b"synthetic attachment");
    let root = beta.join("project-artifacts/12345678-1234-1234-1234-123456789abc");
    let hooks = ycoding_core::resources::project_artifact::filesystem::Hooks::default();
    assert_eq!(
        ycoding_core::resources::project_artifact::filesystem::read_text(
            &root,
            &root.join("versions/test.md"),
            &hooks
        )
        .unwrap(),
        "source artifact"
    );
    let new = reader.import(b"acknowledged beta resource").unwrap();
    std::fs::write(beta.join(artifact), "beta artifact").unwrap();
    std::fs::write(
        fixture.source().parent().unwrap().join(artifact),
        "later stable artifact",
    )
    .unwrap();
    std::fs::remove_file(fixture.marker()).unwrap();
    fixture
        .activate(import::DatabaseKind::Core, |_| Ok(()))
        .unwrap();
    assert_eq!(reader.read(&new).unwrap(), b"acknowledged beta resource");
    assert_eq!(
        std::fs::read_to_string(beta.join(artifact)).unwrap(),
        "beta artifact"
    );
    assert_eq!(reader.read(&attachment).unwrap(), b"synthetic attachment");
}

#[test]
fn core_recovery_preserves_event_order_pending_work_and_opaque_outcomes() {
    use ycoding_core::ycoding_store::{KeyPart, session, tuple_key};
    let fixture = Fixture::new();
    fixture.create(import::DatabaseKind::Core, "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES('p','/synthetic',0,1,'[]'); INSERT INTO session(id,project_id,directory,title,time_created,time_updated) VALUES('ses-recovery','p','/synthetic','fixture',0,1); INSERT INTO event_sequence VALUES('ses-recovery',1,NULL); INSERT INTO event VALUES('evt-source','ses-recovery',1,1,'synthetic.outcome.1','{\"outcome\":\"unknown\"}');");
    assert!(
        fixture
            .activate(import::DatabaseKind::Core, |phase| {
                if phase != Phase::StorePublished {
                    return Ok(());
                }
                let store = Store::open(
                    fixture.file(),
                    Options::core(),
                    import::catalog(import::DatabaseKind::Core),
                )
                .unwrap();
                store
                    .submit(|tx| {
                        session::SequenceTable::put(
                            tx,
                            &session::Sequence {
                                aggregate_id: "ses-recovery".into(),
                                seq: 2,
                                owner_id: None,
                            },
                        )?;
                        session::EventTable::put(
                            tx,
                            &session::Event {
                                id: "evt-beta".into(),
                                aggregate_id: "ses-recovery".into(),
                                seq: 2,
                                created: 2,
                                type_: "synthetic.outcome.1".into(),
                                data: parse_json("{\"outcome\":\"unknown\",\"origin\":\"beta\"}")
                                    .unwrap(),
                            },
                        )?;
                        session::PendingTable::put(
                            tx,
                            &session::Pending {
                                id: "inp-beta".into(),
                                session_id: "ses-recovery".into(),
                                type_: "user".into(),
                                data: parse_json("{\"text\":\"acknowledged queue\"}").unwrap(),
                                delivery: Some("queue".into()),
                                admitted_seq: 2,
                                time_created: 2,
                            },
                        )
                    })
                    .unwrap()
                    .wait()
                    .unwrap();
                store.shutdown().unwrap();
                Err(LaunchError::Usage("after acknowledged write".into()))
            })
            .is_err()
    );
    fixture
        .activate(import::DatabaseKind::Core, |_| Ok(()))
        .unwrap();
    let store = Store::open(
        fixture.file(),
        Options::core(),
        import::catalog(import::DatabaseKind::Core),
    )
    .unwrap();
    let snapshot = store.snapshot().unwrap();
    let first = snapshot
        .index::<session::EventTable>(
            "event_aggregate_seq_idx",
            &tuple_key(&[KeyPart::String(&"ses-recovery".into()), KeyPart::I64(1)]),
            None,
            1,
        )
        .unwrap();
    let second = snapshot
        .index::<session::EventTable>(
            "event_aggregate_seq_idx",
            &tuple_key(&[KeyPart::String(&"ses-recovery".into()), KeyPart::I64(2)]),
            None,
            1,
        )
        .unwrap();
    assert_eq!(first[0].id.as_str(), Some("evt-source"));
    assert_eq!(second[0].id.as_str(), Some("evt-beta"));
    assert_eq!(
        second[0].data,
        parse_json("{\"outcome\":\"unknown\",\"origin\":\"beta\"}").unwrap()
    );
    let pending = snapshot
        .get::<session::PendingTable>(&tuple_key(&[KeyPart::String(&"inp-beta".into())]))
        .unwrap()
        .unwrap();
    assert_eq!(
        pending.delivery.as_ref().and_then(LosslessString::as_str),
        Some("queue")
    );
    assert_eq!(pending.admitted_seq, 2);
    assert_eq!(
        pending.data,
        parse_json("{\"text\":\"acknowledged queue\"}").unwrap()
    );
    drop(snapshot);
    store.shutdown().unwrap();
}

fn attachment_sql(
    content: &ycoding_core::ycoding_schema::prompt::ManagedAttachmentContent,
) -> String {
    let data = format!(
        "{{\"text\":\"synthetic\",\"files\":[{{\"mime\":\"text/plain\",\"content\":{}}}]}}",
        stringify_json(&content.encode())
    );
    format!(
        "INSERT INTO project(id,worktree,time_created,time_updated,sandboxes) VALUES('p','/synthetic',0,1,'[]'); INSERT INTO session(id,project_id,directory,title,time_created,time_updated) VALUES('ses-resource','p','/synthetic','fixture',0,1); INSERT INTO session_message(id,session_id,type,seq,time_created,time_updated,data) VALUES('msg-resource','ses-resource','user',1,0,1,'{data}');"
    )
}

#[test]
fn missing_referenced_managed_resource_refuses_activation() {
    let fixture = Fixture::new();
    fixture.create(import::DatabaseKind::Core, "");
    let attachments = ycoding_core::resources::attachment_store::Store::new(
        fixture.source().parent().unwrap().to_path_buf(),
    )
    .unwrap();
    let content = attachments.import(b"synthetic referenced content").unwrap();
    fixture.sql(&attachment_sql(&content));
    std::fs::remove_file(attachments.absolute_path(&content).unwrap()).unwrap();
    assert!(matches!(
        fixture.activate(import::DatabaseKind::Core, |_| Ok(())),
        Err(LaunchError::Import(ImportError::Resources))
    ));
    assert!(!fixture.file().exists());
    assert!(!fixture.marker().exists());
}

#[test]
fn v1_marker_and_unbound_published_store_are_refused_without_replacement() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.marker().parent().unwrap()).unwrap();
    let old = "{\"complete\":true,\"version\":1,\"imported\":false}";
    std::fs::write(fixture.marker(), old).unwrap();
    assert!(matches!(
        fixture.activate(import::DatabaseKind::Bootstrap, |_| Ok(())),
        Err(LaunchError::Import(ImportError::LegacyMarker))
    ));
    assert_eq!(std::fs::read_to_string(fixture.marker()).unwrap(), old);
    std::fs::remove_file(fixture.marker()).unwrap();
    std::fs::create_dir_all(fixture.file().parent().unwrap()).unwrap();
    std::fs::write(fixture.file(), b"unknown store").unwrap();
    assert!(matches!(
        fixture.activate(import::DatabaseKind::Bootstrap, |_| Ok(())),
        Err(LaunchError::Import(ImportError::InvalidState))
    ));
    assert_eq!(std::fs::read(fixture.file()).unwrap(), b"unknown store");
}

#[test]
fn corrupt_empty_store_candidate_is_never_published_or_selected() {
    let fixture = Fixture::new();
    assert!(
        fixture
            .activate(import::DatabaseKind::Bootstrap, |phase| {
                if phase == Phase::Sealed {
                    Err(LaunchError::Usage("interrupt".into()))
                } else {
                    Ok(())
                }
            })
            .is_err()
    );
    let state = read_selection(
        &fixture.marker().with_extension("stage-v2"),
        import::DatabaseKind::Bootstrap,
    )
    .unwrap();
    let candidate = fixture
        .file()
        .with_file_name(format!(".stable-import-{}.redb", state.id));
    std::fs::write(&candidate, b"corrupt private candidate").unwrap();
    assert!(matches!(
        fixture.activate(import::DatabaseKind::Bootstrap, |_| Ok(())),
        Err(LaunchError::Import(ImportError::InvalidState))
    ));
    assert!(!fixture.file().exists());
    assert!(!fixture.marker().exists());
    assert_eq!(
        std::fs::read(candidate).unwrap(),
        b"corrupt private candidate"
    );
}

#[test]
fn live_meeting_owner_is_refused_by_observation_without_signalling_it() {
    use std::io::BufRead;
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.source().parent().unwrap()).unwrap();
    let mut child = Command::new("python3")
        .args([
            "-c",
            "import sys;print('ready',flush=True);sys.stdin.read()",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim(), "ready");
    let lock = fixture.source().parent().unwrap().join("runtime.lock");
    let contents = format!("{{\"pid\":{}}}", child.id());
    std::fs::write(&lock, &contents).unwrap();
    let result = fixture.activate(import::DatabaseKind::Meeting, |_| Ok(()));
    let still_running = child.try_wait().unwrap().is_none();
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(matches!(
        result,
        Err(LaunchError::Import(ImportError::MeetingBusy))
    ));
    assert!(still_running);
    assert_eq!(std::fs::read_to_string(lock).unwrap(), contents);
    assert!(!fixture.file().exists());
}

#[test]
fn activation_child() {
    let Ok(root) = std::env::var("YCODING_ACTIVATION_CHILD_ROOT") else {
        return;
    };
    let fixture = Fixture(PathBuf::from(root));
    let phase = std::env::var("YCODING_ACTIVATION_CHILD_PHASE").unwrap();
    fixture
        .activate(import::DatabaseKind::Bootstrap, |current| {
            if format!("{current:?}") == phase {
                use std::io::{Read, Write};
                if current == Phase::StorePublished {
                    beta_write(&fixture);
                }
                println!("ACTIVATION-CHECKPOINT");
                std::io::stdout().flush().unwrap();
                std::io::stdin().read_exact(&mut [0]).unwrap();
            }
            Ok(())
        })
        .unwrap();
}

#[test]
fn real_process_death_recovers_per_store_selection_and_acknowledged_writes() {
    for phase in [
        "Copied",
        "Imported(Created)",
        "Imported(Verifying)",
        "Sealed",
        "ResourcesPublished",
        "StorePublished",
        "MarkerPublished",
    ] {
        let fixture = Fixture::new();
        fixture.create(import::DatabaseKind::Bootstrap, "");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "launch::activation::tests::activation_child",
                "--nocapture",
            ])
            .env("YCODING_ACTIVATION_CHILD_ROOT", &fixture.0)
            .env("YCODING_ACTIVATION_CHILD_PHASE", phase)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(stdout).lines() {
                if line.unwrap() == "ACTIVATION-CHECKPOINT" {
                    sender.send(()).unwrap();
                    break;
                }
            }
        });
        let ready = receiver.recv_timeout(std::time::Duration::from_secs(30));
        child.kill().unwrap();
        child.wait().unwrap();
        reader.join().unwrap();
        ready.unwrap();
        fixture
            .activate(import::DatabaseKind::Bootstrap, |_| Ok(()))
            .unwrap();
        assert_eq!(
            fixture.rows(import::DatabaseKind::Bootstrap).len(),
            if phase == "StorePublished" { 2 } else { 1 }
        );
    }
}
